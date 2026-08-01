// IG授权 → IG绑定 绑定率（两个时间段对比）
//   IG授权 = pwa_earning_ins_task_page_two_click（Ins授权回调·授权成功，SOP 口径 T1）
//   IG绑定 = pwa_task_complete + task_id=110（绑定Ins任务完成）
// 两种算法都跑，交叉验证：
//   ① 分步去重比 = 整段去重(绑定) / 整段去重(授权) —— SOP 常用，但分子分母不保证是同一批人
//   ② 漏斗转化率 = BytePlus funnel（同一批人按顺序走完两步），更严格
import { postAnalysis } from "./lib/byteplus.mjs";
import { BYTEPLUS } from "./config.mjs";
import { KEY_METRIC_TIMEZONE } from "./lib/key-metrics.mjs";

const TZ = KEY_METRIC_TIMEZONE; // America/Chicago，与看板其它 IG 指标同一天界
const PERIODS = [
  { label: "6/22 ~ 6/28", from: "2026-06-22", to: "2026-06-28" },
  { label: "7/01 ~ 7/07", from: "2026-07-01", to: "2026-07-07" },
  { label: "7/24 ~ 7/31(校验)", from: "2026-07-24", to: "2026-07-31" },
];

const cond = (pt, pn, op, pv) => ({ logic: "or", conditions: [{ property_type: pt, property_name: pn, property_compose_type: "origin", property_operation: op, property_values: pv }] });
const IS_TEST = [cond("profile", "is_test", "!=", ["true", ""]), cond("event_param", "isTest", "!=", ["true"])];
const TASK110 = [{ expression: { logic: "and", expressions: [cond("event_param", "task_id", "=", [110])] } }];

// 目标时区某日 00:00 的 UTC 秒（Intl 反推偏移，DST 安全）
function tzMidnight(ymd, tz) {
  const guess = Date.parse(`${ymd}T00:00:00Z`);
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit" })
    .formatToParts(new Date(guess)).reduce((a, x) => ((a[x.type] = x.value), a), {});
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour === "24" ? 0 : Number(p.hour));
  return Math.floor((guess - (asUTC - guess)) / 1000);
}
// ⚠️ granularity:"all" 必须带 align_unit/skip_period/week_start，否则 spans 被静默忽略、只返回最近一天多
const period = (from, to, granularity) => ({
  granularity, type: "past_range", timezone: TZ, week_start: 1,
  ...(granularity === "all" ? { align_unit: "day", skip_period: false } : {}),
  spans: [{ type: "timestamp", timestamp: String(tzMidnight(from, TZ)) },
          { type: "timestamp", timestamp: String(tzMidnight(to, TZ) + 86399) }],
});
const ev = (name, label, filters = []) => ({
  event_name: name, event_type: "origin", show_name: name, groups_v2: [], filters,
  show_label: label, event_indicator: "event_users", measure_info: {}, indicator_show_name: "",
});

async function dedup(from, to, name, filters) {
  const dsl = {
    use_app_cloud_id: true, app_ids: [BYTEPLUS.appId], version: 3,
    periods: [period(from, to, "all")],
    content: {
      profile_groups_v2: [], orders: [], query_type: "event",
      profile_filters: [{ expression: { logic: "and", expressions: IS_TEST } }],
      queries: [[ev(name, "A", filters)]],
      page: { limit: 1000, offset: 0 }, option: { refresh_cache: false, fusion: false },
    },
  };
  const j = await postAnalysis(dsl);
  if (j.code !== 200) throw new Error(`${j.code} ${j.message}`);
  const q = j.data?.[0];
  return { n: Number(q?.data_item_list?.[0]?.sum) || 0, span: String(q?.date_index_list?.[0] || "") };
}

async function funnel(from, to) {
  const dsl = {
    use_app_cloud_id: true, app_ids: [BYTEPLUS.appId], version: 3,
    periods: [period(from, to, "all")],
    content: {
      profile_groups_v2: [], orders: [], query_type: "funnel",
      profile_filters: [{ expression: { logic: "and", expressions: IS_TEST } }],
      queries: [[ev("pwa_earning_ins_task_page_two_click", "A"), ev("pwa_task_complete", "B", TASK110)]],
      page: { limit: 1000, offset: 0 },
      option: { refresh_cache: false, fusion: false, window_period: 7, window_period_type: "day" },
    },
  };
  const j = await postAnalysis(dsl);
  if (j.code !== 200) return { err: `${j.code} ${j.message}` };
  const it = j.data?.[0]?.data_item_list?.[0];
  return { raw: it?.data, sum: it?.sum };
}

console.log(`IG授权 → IG绑定 绑定率（时区 ${TZ}，已排测试用户）\n`);
for (const p of PERIODS) {
  const auth = await dedup(p.from, p.to, "pwa_earning_ins_task_page_two_click", []);
  const bind = await dedup(p.from, p.to, "pwa_task_complete", TASK110);
  const rate = auth.n > 0 ? (bind.n / auth.n) * 100 : 0;
  console.log(`【${p.label}】  实际覆盖: ${auth.span}`);
  console.log(`  IG授权(去重人数)  ${String(auth.n).padStart(6)}`);
  console.log(`  IG绑定(去重人数)  ${String(bind.n).padStart(6)}`);
  console.log(`  绑定率            ${rate.toFixed(2).padStart(6)}%`);
  const f = await funnel(p.from, p.to);
  console.log(`  [漏斗交叉验证]    ${f.err ? "不支持/报错: " + f.err : JSON.stringify(f.raw)}`);
  console.log("");
}
