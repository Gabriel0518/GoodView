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

const CAMPAIGN_COLS = [
  { name: "date", type: "date" },
  { name: "account_id", type: "text" },
  { name: "account_name", type: "text" },
  { name: "channel", type: "text" },
  { name: "campaign_id", type: "text" },
  { name: "campaign_name", type: "text" },
  { name: "cost", type: "numeric" },
  { name: "impression", type: "bigint" },
  { name: "click", type: "bigint" },
];

async function main() {
  const days = Number(process.argv[2]) || SETTINGS.defaultLookbackDays;
  const today = new Date();
  const end_ = new Date(today); end_.setDate(end_.getDate() - 1);      // 昨天（最后完整日）
  const start = new Date(today); start.setDate(start.getDate() - days);
  const [startDate, endDate] = [ymd(start), ymd(end_)];

  console.log(`[snapshot] 拉取 ${startDate} ~ ${endDate}（${days} 天）...`);

  const M = ["cost", "impression", "click"];
  const dim = ["date", "account_name", "campaign_id", "campaign_name"];

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
      .map((r) => ({
        date: r.date,
        account_id: r.account_id || r.account_name,
        account_name: r.account_name || r.account_id,
        channel: r.module,
        campaign_id: r.campaign_id,
        campaign_name: r.campaign_name || r.campaign_id,
        cost: Number(r.cost) || 0,
        impression: Number(r.impression) || 0,
        click: Number(r.click) || 0,
      }))
      .filter((r) => {
        if (!r.campaign_id || !r.date) { dropped++; return false; } // PK 依赖 campaign_id（正确性红线5）
        return true;
      });

  for (const [cs, ce] of chunks) {
    if (chunks.length > 1) console.log(`[snapshot]   段 ${cs} ~ ${ce} …`);
    const part = await fetchReport({ startDate: cs, endDate: ce, dimension: dim, metrics: M });
    const rows = transform(part);
    if (!rows.length) continue;
    const coveredDates = [...new Set(rows.map((r) => r.date))];
    // campaign_daily：按本段覆盖的日期删除 + 分批插入（同一事务，处理缩量再拉）
    await withTx(async (c) => {
      await c.query("DELETE FROM campaign_daily WHERE date = ANY($1::date[])", [coveredDates]);
      await bulkInsert(c, "campaign_daily", CAMPAIGN_COLS, rows);
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
