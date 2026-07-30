// 关键指标 × 地区（德州/非德州/全量）抓取 → Postgres key_metric_daily。
// 口径 = BytePlus「PWA 德州关键指标转化率看板」官方配置，定义在 lib/key-metrics.mjs。
// 6 指标 × 3 地区 = 18 个日序列请求（并发池）；细分筛选（排测试用户）由 lib/byteplus.mjs 统一加。
// 时区 = America/Chicago（德州本地），与 BytePlus 官方德州看板一致 —— 见 lib/key-metrics.mjs
//   KEY_METRIC_TIMEZONE 的注释（2026-07-30 用用户参考数逐个核对确认，四个数完全命中）。
//   注意这条管道**不用**项目默认的 Asia/Shanghai（那个给 funnel 用，别混）。
// 用法：node fetch-key-metrics.mjs [天数] [并发数]   默认 30 天、并发 6
import { fetchEventDaily, REGION_EXPRS } from "./lib/byteplus.mjs";
import { KEY_METRICS, REGIONS, KEY_METRIC_TIMEZONE } from "./lib/key-metrics.mjs";
import { pMap } from "./lib/http.mjs";
import { withTx, bulkInsert, end } from "./lib/db.mjs";

const DAYS = Number(process.argv[2]) || 30;
const CONCURRENCY = Number(process.argv[3]) || 6;
const pad = (s, n) => String(s).padEnd(n);
const COLS = [
  { name: "date", type: "date" },
  { name: "metric_key", type: "text" },
  { name: "region", type: "text" },
  { name: "count", type: "bigint" },
];

// 任务 = 指标 × 地区
const jobs = [];
for (const m of KEY_METRICS) for (const r of REGIONS) jobs.push({ m, r });

async function fetchOne({ m, r }) {
  const daily = await fetchEventDaily({
    eventName: m.event,
    lastDays: DAYS,
    indicator: m.indicator,
    filters: m.filters || null,
    profileExpressions: REGION_EXPRS[r.key],
    timezone: KEY_METRIC_TIMEZONE,
  });
  return { metric: m.key, region: r.key, daily };
}

async function main() {
  const t0 = Date.now();
  console.log(`拉取关键指标 × 地区（最近 ${DAYS} 天，${KEY_METRICS.length} 指标 × ${REGIONS.length} 地区 = ${jobs.length} 请求，并发 ${CONCURRENCY}，时区 ${KEY_METRIC_TIMEZONE}）\n`);

  const results = await pMap(jobs, fetchOne, CONCURRENCY);

  // 按 (metric, region) 归集；整个请求失败的组合记为 failed（不写库，保留旧数据）
  const byKey = new Map();
  const failed = [];
  let dates = [];
  results.forEach((res, i) => {
    const { m, r } = jobs[i];
    if (!res || res.__error) {
      failed.push(`${m.label}/${r.label}: ${String(res?.__error?.message || "无结果").replace(/\s+/g, " ").slice(0, 40)}`);
      return;
    }
    byKey.set(`${res.metric}|${res.region}`, res.daily);
    if (res.daily.length) dates = res.daily.map((x) => x.date);
  });

  if (!byKey.size) {
    console.log("❌ 全部失败（网络/鉴权问题？），已跳过写库，保留原数据");
    await end();
    process.exit(1);
  }

  // 汇总表（列=地区）
  console.log(`${pad("关键指标", 14)} ${pad("指标类型", 10)} ${REGIONS.map((r) => pad(r.label, 10)).join("")}`);
  for (const m of KEY_METRICS) {
    const cells = REGIONS.map((r) => {
      const d = byKey.get(`${m.key}|${r.key}`);
      return pad(d ? d.reduce((a, x) => a + x.count, 0) : "失败", 10);
    });
    console.log(`${pad(m.label, 14)} ${pad(m.indicator === "events" ? "PV(次数)" : "UV(人数)", 10)} ${cells.join("")}`);
  }

  // 写库：按 (date, metric_key, region) 删除+插入，只动成功的组合
  const rows = [];
  for (const [k, daily] of byKey) {
    const [metric_key, region] = k.split("|");
    for (const d of daily) rows.push({ date: d.date, metric_key, region, count: d.count });
  }
  const metricKeys = [...new Set(rows.map((r) => r.metric_key))];
  const regionKeys = [...new Set(rows.map((r) => r.region))];
  await withTx(async (c) => {
    await c.query(
      `DELETE FROM key_metric_daily
        WHERE date = ANY($1::date[]) AND metric_key = ANY($2::text[]) AND region = ANY($3::text[])`,
      [dates, metricKeys, regionKeys],
    );
    await bulkInsert(c, "key_metric_daily", COLS, rows);
  });

  console.log(`\n✅ [key-metrics] 已写入 Postgres：${byKey.size}/${jobs.length} 组合，${rows.length} 行（耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);
  if (failed.length) {
    console.log(`⚠️ ${failed.length} 个组合失败（保留旧数据）：`);
    failed.forEach((f) => console.log(`   - ${f}`));
  }
  await end();
}

main().catch(async (e) => {
  console.error("[key-metrics] 失败：", e.message);
  if (e.cause) console.error("底层原因：", e.cause);
  await end().catch(() => {});
  process.exit(1);
});
