// 取数：拉 XMP campaign×date 明细 + BytePlus IG授权按天 → 写入 Postgres。
// byDate/byChannel/byChannelDate 不再预算，由 app/lib/db-queries.ts 从 campaign_daily 聚合派生。
// 用法：node fetch-snapshot.mjs [天数]   （默认 30 天，取最近 N 个完整日，不含今天）
import { fetchReport } from "./lib/xmp.mjs";
import { fetchEventDaily } from "./lib/byteplus.mjs";
import { BYTEPLUS, SETTINGS } from "./config.mjs";
import { query, withTx, bulkInsert, end } from "./lib/db.mjs";

const ymd = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// 把 [start,end]（含端点）拆成 ≤maxDays 天的子窗口。XMP 单次最多 90 天。
function dateChunks(startYmd, endYmd, maxDays) {
  const out = [];
  let s = startYmd;
  while (s <= endYmd) {
    const cand = addDays(s, maxDays - 1);
    const e = cand > endYmd ? endYmd : cand;
    out.push([s, e]);
    s = addDays(e, 1);
  }
  return out;
}
const XMP_MAX_DAYS = Number(process.env.XMP_MAX_DAYS || 90);

// XMP 在 adset 粒度会返回重复行（实测多为 0 值的完全重复行；亦可能有隐藏子维拆分）。
// 按 PK (date, account_id, campaign_id, adset_id) 聚合求和 → 天然去重、且隐藏拆分被正确合并。
// 已验证：adset 级聚合总额 == campaign 级总额（仅 XMP 自身分级舍入的微差）。
const KEY_SEP = String.fromCharCode(31); // US 分隔符，绝不出现在日期/ID/名称中，避免键边界歧义
function aggregateByPk(rows, extMetrics = []) {
  const m = new Map();
  for (const r of rows) {
    const k = r.date + KEY_SEP + r.account_id + KEY_SEP + r.campaign_id + KEY_SEP + r.adset_id;
    const o = m.get(k);
    if (o) {
      o.cost += r.cost; o.impression += r.impression; o.click += r.click;
      for (const e of extMetrics) o._ext[e] = (o._ext[e] || 0) + (r._ext?.[e] || 0);
    } else {
      m.set(k, { ...r, _ext: { ...(r._ext || {}) } });
    }
  }
  return [...m.values()];
}

const CAMPAIGN_COLS = [
  { name: "date", type: "date" },
  { name: "account_id", type: "text" },
  { name: "account_name", type: "text" },
  { name: "channel", type: "text" },
  { name: "campaign_id", type: "text" },
  { name: "campaign_name", type: "text" },
  { name: "adset_id", type: "text" },
  { name: "adset_name", type: "text" },
  { name: "cost", type: "numeric" },
  { name: "impression", type: "bigint" },
  { name: "click", type: "bigint" },
];

// 扩展指标长表列（ext 指标落这里）
const METRIC_COLS = [
  { name: "date", type: "date" },
  { name: "account_id", type: "text" },
  { name: "campaign_id", type: "text" },
  { name: "adset_id", type: "text" },
  { name: "metric_key", type: "text" },
  { name: "value", type: "numeric" },
];

// 结构性核心指标（campaign_daily 三大列，始终抓取作floor，防止误删配置把列洗空）。ext 指标由配置追加。
const CORE_METRICS = ["cost", "impression", "click"];

// 读 XMP 抓取配置（xmp_fetch_config）：ext 指标 + 抓取范围（账户/系列白名单）。
// 表不存在/查不到 → 空配置（仅抓核心、抓全部账户，不空跑）。
async function loadXmpConfig() {
  try {
    const { rows } = await query(
      `SELECT category, value, store_layer FROM xmp_fetch_config WHERE enabled = true`,
    );
    const ext = [...new Set(rows.filter((r) => r.category === "metric" && r.store_layer === "ext").map((r) => r.value))];
    const accounts = new Set(rows.filter((r) => r.category === "account").map((r) => r.value));
    const campaigns = new Set(rows.filter((r) => r.category === "campaign").map((r) => r.value));
    return { ext, accounts, campaigns, scopeActive: accounts.size > 0 || campaigns.size > 0 };
  } catch (e) {
    console.warn(`[snapshot] 读 xmp_fetch_config 失败，仅抓核心指标、抓全部账户：${e.message}`);
    return { ext: [], accounts: new Set(), campaigns: new Set(), scopeActive: false };
  }
}

async function main() {
  const days = Number(process.argv[2]) || SETTINGS.defaultLookbackDays;
  const today = new Date();
  const end_ = new Date(today);
  if (!process.env.INCLUDE_TODAY) end_.setDate(end_.getDate() - 1);   // 默认到昨天（最后完整日）；INCLUDE_TODAY=1 含今天（当天进行中，抢先看）
  const start = new Date(today); start.setDate(start.getDate() - days);
  const [startDate, endDate] = [ymd(start), ymd(end_)];

  console.log(`[snapshot] 拉取 ${startDate} ~ ${endDate}（${days} 天）...`);

  const { ext: extMetrics, accounts, campaigns, scopeActive } = await loadXmpConfig();
  const M = [...new Set([...CORE_METRICS, ...extMetrics])]; // 核心三列 + 配置 ext 指标，一次报表拿全
  const dim = ["date", "account_name", "campaign_id", "campaign_name", "adset_id", "adset_name"];
  if (extMetrics.length) console.log(`[snapshot] ext 指标（长表）：${extMetrics.join(", ")}`);
  if (scopeActive) console.log(`[snapshot] 抓取范围=白名单：账户 ${accounts.size} 个 · 系列 ${campaigns.size} 个（账户∪系列）`);
  // 白名单命中：行的账户或系列（id 或名称任一）在配置集合内。空范围 → 全通过（抓全部）。
  const inScope = (r) =>
    !scopeActive ||
    accounts.has(r.account_id) || accounts.has(r.account_name) ||
    campaigns.has(r.campaign_id) || campaigns.has(r.campaign_name);

  // XMP 单次最多 90 天：>90 天时分段拉取再合并。BytePlus IG 并行拉（无此限制）。
  const chunks = dateChunks(startDate, endDate, XMP_MAX_DAYS);
  if (chunks.length > 1) console.log(`[snapshot] XMP 单次限 ${XMP_MAX_DAYS} 天，本次 ${days} 天分 ${chunks.length} 段拉取`);
  const igPromise = fetchEventDaily({ eventName: BYTEPLUS.igAuthEvent, lastDays: days });

  // 逐段拉取并即时写库（长回补时某段失败不丢已写入的段）。
  let dropped = 0;
  let totalRows = 0;
  const allDates = new Set();
  const byDate = {};
  const transform = (part) =>
    part
      .map((r) => {
        const o = {
          date: r.date,
          account_id: r.account_id || r.account_name,
          account_name: r.account_name || r.account_id,
          channel: r.module,
          campaign_id: r.campaign_id,
          campaign_name: r.campaign_name || r.campaign_id,
          adset_id: r.adset_id || "_",           // 无 adset 时占位（对齐 schema/主键）
          adset_name: r.adset_name || r.adset_id || "_",
          cost: Number(r.cost) || 0,
          impression: Number(r.impression) || 0,
          click: Number(r.click) || 0,
        };
        if (extMetrics.length) {
          o._ext = {};
          for (const e of extMetrics) o._ext[e] = Number(r[e]) || 0;
        }
        return o;
      })
      .filter((r) => {
        if (!r.campaign_id || !r.date) { dropped++; return false; } // PK 依赖 campaign_id（正确性红线5）
        return true;
      });

  for (const [cs, ce] of chunks) {
    if (chunks.length > 1) console.log(`[snapshot]   段 ${cs} ~ ${ce} …`);
    const part = await fetchReport({ startDate: cs, endDate: ce, dimension: dim, metrics: M });
    const partT = transform(part);                                  // 全部行（未过滤范围），含 _ext
    const windowDates = [...new Set(partT.map((r) => r.date))];      // 本段完整窗口（含未列名账户）
    const scoped = scopeActive ? partT.filter(inScope) : partT;      // 白名单过滤
    const rows = aggregateByPk(scoped, extMetrics);                  // 折叠 XMP adset 重复行至 PK 粒度，防主键冲突
    // 白名单命中为空（可能配置写错）→ 跳过本段，绝不删空已有数据（防误配洗库）。
    if (!rows.length) { if (scopeActive && windowDates.length) console.warn(`[snapshot]   段 ${cs}~${ce} 白名单未命中任何行，跳过（不改动已有数据）`); continue; }
    // 删除范围=完整窗口 → 白名单下未列名账户在本窗口内被清掉（用户选定的「只抓填的」语义）。
    const coveredDates = scopeActive ? windowDates : [...new Set(rows.map((r) => r.date))];
    // 扩展指标长表行（每行 × 每个 ext 指标一行）
    const metricRows = extMetrics.length
      ? rows.flatMap((r) => extMetrics.map((e) => ({
          date: r.date, account_id: r.account_id, campaign_id: r.campaign_id,
          adset_id: r.adset_id, metric_key: e, value: r._ext[e] || 0,
        })))
      : [];
    // campaign_daily + campaign_metric_daily：按本段覆盖的日期删除 + 分批插入（同一事务，处理缩量再拉）
    await withTx(async (c) => {
      await c.query("DELETE FROM campaign_daily WHERE date = ANY($1::date[])", [coveredDates]);
      await bulkInsert(c, "campaign_daily", CAMPAIGN_COLS, rows);
      if (extMetrics.length) {
        await c.query(
          "DELETE FROM campaign_metric_daily WHERE date = ANY($1::date[]) AND metric_key = ANY($2::text[])",
          [coveredDates, extMetrics],
        );
        await bulkInsert(c, "campaign_metric_daily", METRIC_COLS, metricRows);
      }
    });
    totalRows += rows.length;
    coveredDates.forEach((d) => allDates.add(d));
    for (const r of rows) {
      const o = (byDate[r.date] ||= { cost: 0, imp: 0, clk: 0 });
      o.cost += r.cost; o.imp += r.impression; o.clk += r.click;
    }
  }

  const igDaily = await igPromise;

  if (!totalRows) {
    console.error("[snapshot] XMP 未返回 campaign 数据，跳过写库（保留旧数据）");
    await end();
    process.exit(1);
  }

  // ig_auth_daily：按日期 upsert
  for (const { date, count } of igDaily) {
    await query(
      `INSERT INTO ig_auth_daily (date, count, updated_at) VALUES ($1,$2, now())
       ON CONFLICT (date) DO UPDATE SET count = EXCLUDED.count, updated_at = now()`,
      [date, count],
    );
  }

  // 控制台摘要
  const tot = Object.values(byDate).reduce(
    (a, o) => ({ cost: a.cost + o.cost, imp: a.imp + o.imp, clk: a.clk + o.clk }),
    { cost: 0, imp: 0, clk: 0 },
  );
  const igTot = igDaily.reduce((a, x) => a + (x.count || 0), 0);
  console.log(
    `[snapshot] 入库 ${totalRows} 行 campaign_daily（${allDates.size} 天）` +
    `${dropped ? `，丢弃 ${dropped} 行空id` : ""} | ig_auth_daily ${igDaily.length} 天`,
  );
  console.log(`[snapshot] 合计: 花费 $${tot.cost.toFixed(2)} | 曝光 ${tot.imp} | 点击 ${tot.clk} | IG授权 ${igTot}`);
  console.log("✅ [snapshot] 已写入 Postgres");

  await end();
}

main().catch(async (e) => {
  console.error("[snapshot] 失败：", e.message);
  if (e.cause) console.error("底层原因：", e.cause);
  await end().catch(() => {});
  process.exit(1);
});
