// 校验注册口径：pwa_conv_cash_ready_pop_show 的「整段去重 UV」vs「逐日 UV 求和」。
// 两者接近 ⇒ 每人只触发一次，日值=真·新增注册；差得多 ⇒ 同一人跨天重复触发，日值含回访。
import { postAnalysis, REGION_EXPRS } from "./lib/byteplus.mjs";
import { BYTEPLUS } from "./config.mjs";
import { KEY_METRIC_TIMEZONE } from "./lib/key-metrics.mjs";
import { query, end } from "./lib/db.mjs";

const EVENT = "pwa_conv_cash_ready_pop_show";
const TZ = KEY_METRIC_TIMEZONE;
const FROM = "2026-07-02", TO = "2026-07-31"; // 30 天

const cond = (pt, pn, op, pv) => ({ logic: "or", conditions: [{ property_type: pt, property_name: pn, property_compose_type: "origin", property_operation: op, property_values: pv }] });
const IS_TEST = [cond("profile", "is_test", "!=", ["true", ""]), cond("event_param", "isTest", "!=", ["true"])];

// 目标时区某日 00:00 的 UTC 秒
function tzMidnight(ymd, tz) {
  const guess = Date.parse(`${ymd}T00:00:00Z`);
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit" })
    .formatToParts(new Date(guess)).reduce((a, x) => ((a[x.type] = x.value), a), {});
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour === "24" ? 0 : Number(p.hour));
  return Math.floor((guess - (asUTC - guess)) / 1000);
}

async function run(granularity, region) {
  const start = tzMidnight(FROM, TZ);
  const end_ = tzMidnight(TO, TZ) + 86399;
  const dsl = {
    use_app_cloud_id: true, app_ids: [BYTEPLUS.appId], version: 3,
    periods: [{ granularity, type: "past_range", timezone: TZ,
      spans: [{ type: "timestamp", timestamp: String(start) }, { type: "timestamp", timestamp: String(end_) }] }],
    content: {
      profile_groups_v2: [], orders: [], query_type: "event",
      profile_filters: [{ expression: { logic: "and", expressions: [...IS_TEST, ...REGION_EXPRS[region]] } }],
      queries: [[{ event_name: EVENT, event_type: "origin", show_name: EVENT, groups_v2: [], filters: [],
        show_label: "A", event_indicator: "event_users", measure_info: {}, indicator_show_name: "" }]],
      page: { limit: 1000, offset: 0 }, option: { refresh_cache: false, fusion: false },
    },
  };
  const j = await postAnalysis(dsl);
  if (j.code !== 200) throw new Error(`code=${j.code} ${j.message}`);
  const it = j.data?.[0]?.data_item_list?.[0];
  const vals = (it?.data || []).map(Number);
  return { sum: vals.reduce((a, b) => a + b, 0), dedup: Number(it?.sum) || 0, n: vals.length };
}

console.log(`注册口径校验：${EVENT}（${FROM} ~ ${TO}，${TZ}，已排测试用户）\n`);
for (const region of ["all", "TX", "nonTX"]) {
  const day = await run("day", region);
  const all = await run("all", region);
  const ratio = all.dedup > 0 ? day.sum / all.dedup : 0;
  console.log(`${region.padEnd(6)} 逐日UV求和=${String(day.sum).padStart(6)}  整段去重UV=${String(all.dedup).padStart(6)}  倍数=${ratio.toFixed(3)}`);
}

// 同期对比库里的账号创建数（app_name='3'）
const { rows } = await query(
  `SELECT sum(count) AS s FROM key_metric_daily WHERE metric_key='register' AND region='all' AND date BETWEEN $1 AND $2`,
  [FROM, TO]);
console.log(`\n参考：key_metric_daily 存的 30 天注册合计 = ${rows[0].s}`);
await end();
