// 「小美投放转化」→ Postgres xiaomei_conversion_daily。
// 一行 = 日期 × 产品(PWA/AI公会/Savvy/SmartReply) × 渠道(facebook/tiktok/google/未归因)，
// 含投放侧 4 指标（花费/曝光/点击/安装，全部来自 XMP）+ 后端 4 指标（注册/IG绑定/GoLive分发/成材）。
//
// 用法：node fetch-xiaomei.mjs [天数]     默认 7 天（每日 cron 只需 1 天，多回补几天是为了自愈）
//
// ─── 三路数据源 ───────────────────────────────────────────────────────────
// ① 投放侧：**不重新调 XMP**，直接读库里的 campaign_daily + campaign_metric_daily(conversion)。
//    pull-all 每 5 分钟已经把 XMP 拉进这两张表，再调一次既慢（QPM=10）又可能和 cron 抢配额。
//    安装 = XMP 的 conversion（媒体侧回传口径）：上架包=安装数，PWA/AI公会=线索/转化数。
//    （MMP 的 mobile_app_install/af_conversion 对这些账户实测全 0，conversion 是唯一有数的，
//      见 lib/whitelist.mjs 的注释。）
// ② PWA / AI公会 后端：BytePlus，时区锚 America/Chicago。
// ③ SmartReply / Savvy 后端：AppsFlyer —— 读我们自己的 af_events 表（AF Push API 实时推进来的），
//    不用调 AF 接口。Savvy 的 AF Push 端点还没配 → 配好并设 SAVVY_AF_APP_ID 后自动生效。
//
// ─── 日界（这个脚本的核心口径）─────────────────────────────────────────────
// 全部按 **America/Chicago 日** 切 = 北京 13:00 ~ 次日 13:00（冬令时 14:00~14:00，自动跟随）。
// XMP 的日期按上海日切，两边不重切、只做 D↔D 标签对齐（用户 2026-08-16 定）。
// **只写已经结束的芝加哥日**：目标窗口的最后一天 = 昨天(芝加哥)，永远不会把半天的数据写进去。
// ⚠️ cron 定在北京 13:10 是踩着夏令时的日界（13:00 刚结束）。到了冬令时，芝加哥日要到北京 14:00
//    才结束，13:10 跑的时候最新一天还没完 → 那天的数据由**次日**那轮的回补窗口补上（所以默认 7 天，
//    不是 1 天）。想冬天也当天出数，把 cron 从 05:10 UTC 改成 06:10 UTC 即可。
import { fetchEventDaily, fetchEventDailyGrouped } from "./lib/byteplus.mjs";
import { pMap } from "./lib/http.mjs";
import { query, withTx, bulkInsert, end } from "./lib/db.mjs";
import {
  XIAOMEI_TIMEZONE as TZ, PRODUCTS, CHANNELS, UNATTRIBUTED, ALL_CHANNELS,
  AIGUILD_SOURCES, SOURCE_TO_CHANNEL, BACKEND_METRICS, BACKEND_KEYS,
  channelFromMediaSource, PRODUCT_CASE_SQL,
} from "./lib/xiaomei.mjs";

const DAYS = Number(process.argv[2]) || 7;
const CONCURRENCY = Number(process.argv[3]) || 4;

const COLS = [
  { name: "date", type: "date" },
  { name: "product", type: "text" },
  { name: "channel", type: "text" },
  { name: "cost", type: "numeric" },
  { name: "impression", type: "bigint" },
  { name: "click", type: "bigint" },
  { name: "install", type: "bigint" },
  { name: "register", type: "bigint" },
  { name: "ig_bind", type: "bigint" },
  { name: "golive", type: "bigint" },
  { name: "chengcai", type: "bigint" },
];

const ymd = (d) => d.toISOString().slice(0, 10);
const pad = (s, n) => String(s).padEnd(n);
const clamp0 = (n) => Math.max(0, n);

// 窗口 = [最近一个已结束的芝加哥日 − (DAYS−1), 最近一个已结束的芝加哥日]
function windowDates() {
  const todayChi = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date()); // YYYY-MM-DD
  const to = new Date(`${todayChi}T00:00:00Z`);
  to.setUTCDate(to.getUTCDate() - 1);
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - (DAYS - 1));
  return { from: ymd(from), to: ymd(to) };
}

// ───────────────────────── ① 投放侧（XMP，读库）─────────────────────────
// ⚠️ 两个坑：
//   1) campaign_daily 是 adset 粒度、campaign_metric_daily 也是 —— 必须**各自先聚合到系列**再 JOIN，
//      否则 conversion 会被广告组行数放大成 N 倍。
//   2) 范围过滤要 `账户白名单 ∪ 系列白名单`：AI公会那个账户只登记在系列白名单里，
//      只按账户 JOIN 会把 AI公会 整个漏掉（feishu-tables.mjs 里也有同样的说明）。
async function fetchSpend(from, to) {
  const { rows } = await query(
    `WITH ai AS (SELECT value FROM xmp_fetch_config
                  WHERE category='campaign' AND enabled AND group_name ~* 'AI公会|AIguild|公会'),
          acc AS (SELECT value, COALESCE(NULLIF(group_name,''),'PWA') AS grp
                    FROM xmp_fetch_config WHERE category='account' AND enabled),
          cd AS (SELECT date, account_id, campaign_id, channel,
                        SUM(cost) AS cost, SUM(impression) AS impression, SUM(click) AS click
                   FROM campaign_daily WHERE date BETWEEN $1 AND $2
                  GROUP BY 1,2,3,4),
          conv AS (SELECT date, account_id, campaign_id, SUM(value) AS install
                     FROM campaign_metric_daily
                    WHERE metric_key='conversion' AND date BETWEEN $1 AND $2
                    GROUP BY 1,2,3)
     SELECT to_char(c.date,'YYYY-MM-DD') AS date, ${PRODUCT_CASE_SQL} AS product, c.channel,
            SUM(c.cost)::float8 AS cost, SUM(c.impression)::bigint AS impression,
            SUM(c.click)::bigint AS click, COALESCE(SUM(v.install),0)::bigint AS install
       FROM cd c
       LEFT JOIN acc a ON a.value = c.account_id
       LEFT JOIN conv v ON v.date = c.date AND v.account_id = c.account_id AND v.campaign_id = c.campaign_id
      WHERE a.value IS NOT NULL OR c.campaign_id IN (SELECT value FROM ai)
      GROUP BY 1,2,3`,
    [from, to],
  );
  return rows;
}

// ───────────────── ② PWA / AI公会 后端（BytePlus，按 source 拆渠道）─────────────────
// 每个指标 2 个请求：按 source 分组 + 不分组的全量。
//   AI公会 = AIguild + AIguild_active + AIguild_passive（三个互不重叠的 source 取值）
//   PWA    = 全量 − AI公会（用户 2026-08-16 选定：覆盖全部 PWA 用户，含 ~30% source 未归因的，
//            与 XMP 的 PWA 花费口径更匹配；只取 fb+tt 会少约三成）
//   渠道拆分：fb→facebook、tt→tiktok，PWA 剩下的进「未归因」；
//            AI公会 的 source 不带渠道信息 → 整体进「未归因」（花费仍按真实渠道分行）。
async function fetchByteplus(from, to) {
  const lastDays = DAYS + 1; // +1 覆盖「今天(进行中)」，取回后按窗口裁掉
  const results = await pMap(
    BACKEND_METRICS,
    async (m) => {
      const args = { eventName: m.byteplus.event, lastDays, indicator: m.byteplus.indicator, filters: m.byteplus.filters || null, timezone: TZ };
      const [grouped, total] = await Promise.all([
        fetchEventDailyGrouped({ ...args, groupBy: "source", propertyType: "profile", groupLocation: "content" }),
        fetchEventDaily(args),
      ]);
      return { key: m.key, grouped, total };
    },
    CONCURRENCY,
  );

  // out[product][channel][date][metricKey] = 数值；failed = 整条取数失败的指标（写 NULL 而不是 0）
  const out = {};
  const failed = [];
  const put = (product, channel, date, key, val) => {
    ((out[product] ||= {})[channel] ||= {})[date] ||= {};
    out[product][channel][date][key] = val;
  };

  results.forEach((res, i) => {
    const m = BACKEND_METRICS[i];
    if (!res || res.__error) {
      failed.push(`${m.label}: ${String(res?.__error?.message || "无结果").replace(/\s+/g, " ").slice(0, 60)}`);
      return;
    }
    const bySource = new Map(res.grouped.series.map((s) => [String(s.group), s.data]));
    const at = (src, i2) => Number(bySource.get(src)?.[i2] || 0);

    res.grouped.dates.forEach((date, i2) => {
      if (date < from || date > to) return; // 裁掉窗口外 & 进行中的当天
      const totalCnt = Number(res.total.find((t) => t.date === date)?.count || 0);
      const aiguild = AIGUILD_SOURCES.reduce((a, s) => a + at(s, i2), 0);
      const pwaTotal = clamp0(totalCnt - aiguild);
      const fb = at("fb", i2), tt = at("tt", i2);

      put("PWA", "facebook", date, m.key, fb);
      put("PWA", "tiktok", date, m.key, tt);
      put("PWA", UNATTRIBUTED, date, m.key, clamp0(pwaTotal - fb - tt));
      put("AI公会", UNATTRIBUTED, date, m.key, aiguild);
    });
  });

  return { data: out, failed, okKeys: BACKEND_KEYS.filter((k) => !failed.some((f) => f.startsWith(BACKEND_METRICS.find((m) => m.key === k).label))) };
}

// ───────────────── ③ SmartReply / Savvy 后端（AppsFlyer，读 af_events）─────────────────
// 人数口径 = 去重 appsflyer_id（拿不到就退 customer_user_id，再退 dedupe_key=按事件计次）。
// 事件名按 lib/xiaomei.mjs 的候选顺序取**窗口内第一个有数据的**；一个都没有 → 该指标写 NULL。
async function fetchAf(from, to) {
  const wanted = [...new Set(BACKEND_METRICS.flatMap((m) => m.afEvents))];
  const appIds = PRODUCTS.filter((p) => p.backend === "af").flatMap((p) => p.afAppIds);
  if (!wanted.length || !appIds.length) return { data: {}, activeEvents: {}, note: appIds.length ? "无 AF 事件候选" : "无 AF app_id（Savvy 未接入）" };

  const { rows } = await query(
    `SELECT to_char((event_time AT TIME ZONE $3)::date,'YYYY-MM-DD') AS date,
            app_id, event_name, media_source,
            COUNT(DISTINCT COALESCE(appsflyer_id, customer_user_id, dedupe_key))::bigint AS uv
       FROM af_events
      WHERE event_time >= ($1::date::timestamp AT TIME ZONE $3)
        AND event_time <  (($2::date + 1)::timestamp AT TIME ZONE $3)
        AND event_name = ANY($4::text[]) AND app_id = ANY($5::text[])
      GROUP BY 1,2,3,4`,
    [from, to, TZ, wanted, appIds],
  );

  const productOf = new Map(PRODUCTS.filter((p) => p.backend === "af").flatMap((p) => p.afAppIds.map((id) => [id, p.key])));
  const out = {};
  const seenEvents = {}; // product -> Set(有数据的事件名)
  for (const r of rows) {
    const product = productOf.get(r.app_id);
    if (!product) continue;
    (seenEvents[product] ||= new Set()).add(r.event_name);
    const channel = channelFromMediaSource(r.media_source);
    (((out[product] ||= {})[channel] ||= {})[r.date] ||= {})[r.event_name] =
      (out[product][channel][r.date][r.event_name] || 0) + Number(r.uv);
  }

  // 每个产品每个指标，选中候选里第一个在窗口内出现过的事件名；都没有 → null（该指标整列留空）
  const activeEvents = {};
  for (const p of PRODUCTS.filter((x) => x.backend === "af")) {
    activeEvents[p.key] = {};
    for (const m of BACKEND_METRICS) {
      activeEvents[p.key][m.key] = m.afEvents.find((e) => seenEvents[p.key]?.has(e)) || null;
    }
  }
  return { data: out, activeEvents };
}

// ───────────────────────── 合并 → 行 ─────────────────────────
function buildRows({ spend, bp, af, from, to }) {
  const dates = [];
  for (let d = new Date(`${from}T00:00:00Z`); ymd(d) <= to; d.setUTCDate(d.getUTCDate() + 1)) dates.push(ymd(d));

  // 先把三路数据塞进 map[date|product|channel]
  const map = new Map();
  const cell = (date, product, channel) => {
    const k = `${date}|${product}|${channel}`;
    if (!map.has(k)) {
      map.set(k, { date, product, channel, cost: 0, impression: 0, click: 0, install: 0, register: null, ig_bind: null, golive: null, chengcai: null });
    }
    return map.get(k);
  };

  for (const r of spend) {
    const c = cell(r.date, r.product, r.channel);
    c.cost = Number(r.cost) || 0;
    c.impression = Number(r.impression) || 0;
    c.click = Number(r.click) || 0;
    c.install = Number(r.install) || 0;
  }

  // BytePlus 产品（PWA / AI公会）：取数成功的指标全部落数（没数的日/渠道 = 0）；失败的留 NULL。
  for (const p of PRODUCTS.filter((x) => x.backend === "byteplus")) {
    for (const date of dates) {
      for (const ch of ALL_CHANNELS) {
        const got = bp.data[p.key]?.[ch]?.[date];
        // 该产品该渠道在这天既没花费也没后端数 → 不凭空造行
        const existing = map.get(`${date}|${p.key}|${ch}`);
        if (!got && !existing) continue;
        const c = cell(date, p.key, ch);
        for (const key of bp.okKeys) c[key] = Number(got?.[key] || 0);
      }
    }
  }

  // AF 产品（SmartReply / Savvy）：只有「窗口内确实出现过」的事件才落数，否则该指标整列 NULL。
  for (const p of PRODUCTS.filter((x) => x.backend === "af")) {
    const active = af.activeEvents?.[p.key] || {};
    if (!Object.values(active).some(Boolean)) continue; // 该产品完全没有 AF 数据源 → 全 NULL
    for (const date of dates) {
      for (const ch of ALL_CHANNELS) {
        const got = af.data[p.key]?.[ch]?.[date];
        const existing = map.get(`${date}|${p.key}|${ch}`);
        if (!got && !existing) continue;
        const c = cell(date, p.key, ch);
        for (const m of BACKEND_METRICS) {
          const ev = active[m.key];
          if (ev) c[m.key] = Number(got?.[ev] || 0);
        }
      }
    }
  }

  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date) || a.product.localeCompare(b.product) || a.channel.localeCompare(b.channel));
}

async function main() {
  const t0 = Date.now();
  const { from, to } = windowDates();
  console.log(`[小美投放转化] 窗口 ${from} ~ ${to}（${DAYS} 天，按 ${TZ} 日切 = 北京 13:00~次日13:00）\n`);

  const spend = await fetchSpend(from, to);
  console.log(`  ① 投放侧(XMP 读库)：${spend.length} 行 产品×渠道×日`);

  const bp = await fetchByteplus(from, to);
  console.log(`  ② PWA/AI公会(BytePlus)：${bp.okKeys.length}/${BACKEND_METRICS.length} 个指标取数成功`);
  bp.failed.forEach((f) => console.warn(`     ⚠️ ${f}（该指标写 NULL，保留看板留空）`));

  const af = await fetchAf(from, to);
  for (const p of PRODUCTS.filter((x) => x.backend === "af")) {
    const active = af.activeEvents?.[p.key] || {};
    const hit = BACKEND_METRICS.filter((m) => active[m.key]).map((m) => `${m.label}=${active[m.key]}`);
    const miss = BACKEND_METRICS.filter((m) => !active[m.key]).map((m) => m.label);
    console.log(`  ③ ${p.key}(AppsFlyer)：${hit.length ? hit.join(" · ") : af.note || "窗口内无数据"}${miss.length ? `｜留空：${miss.join("/")}` : ""}`);
  }

  const rows = buildRows({ spend, bp, af, from, to });
  if (!rows.length) {
    console.log("\n❌ 没有任何数据，跳过写库，保留原值");
    await end();
    process.exit(1);
  }

  const dates = [...new Set(rows.map((r) => r.date))];
  await withTx(async (c) => {
    await c.query(`DELETE FROM xiaomei_conversion_daily WHERE date = ANY($1::date[])`, [dates]);
    await bulkInsert(c, "xiaomei_conversion_daily", COLS, rows);
  });

  // 汇总打印：最后一天各产品一行，方便 cron 日志里一眼看出数对不对
  const last = rows.filter((r) => r.date === to);
  const n = (v) => (v == null ? "  留空" : String(v).padStart(6));
  console.log(`\n${to} 汇总（各渠道已合计）`);
  console.log(`${pad("产品", 12)}${pad("花费", 11)}${pad("曝光", 10)}${pad("点击", 9)}${pad("安装", 8)}${pad("注册", 8)}${pad("IG绑定", 9)}${pad("GoLive", 8)}${pad("成材", 8)}`);
  for (const p of PRODUCTS) {
    const g = last.filter((r) => r.product === p.key);
    if (!g.length) continue;
    const sum = (k) => (g.every((r) => r[k] == null) ? null : g.reduce((a, r) => a + Number(r[k] || 0), 0));
    console.log(
      pad(p.key, 12) + pad("$" + (sum("cost") || 0).toFixed(2), 11) + pad(sum("impression") || 0, 10) +
      pad(sum("click") || 0, 9) + pad(sum("install") || 0, 8) +
      n(sum("register")) + "  " + n(sum("ig_bind")) + "  " + n(sum("golive")) + "  " + n(sum("chengcai")),
    );
  }

  console.log(`\n✅ [小美投放转化] 已写入 Postgres：${rows.length} 行 / ${dates.length} 天（耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);
  await end();
  if (bp.failed.length) process.exitCode = 1; // 主数据源缺口要让 cron 看得见
}

main().catch(async (e) => {
  console.error("[小美投放转化] 失败：", e.message);
  if (e.cause) console.error("底层原因：", e.cause);
  await end().catch(() => {});
  process.exit(1);
});
