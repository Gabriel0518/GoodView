// 测试：注册事件加上「新用户」条件(user_is_new=1)后，日值是否 = 真·日新增注册
// 对照组：业务库 userinfo app_name='3' 的账号创建数（天然每人一次）
import { postAnalysis } from "./lib/byteplus.mjs";
import { BYTEPLUS } from "./config.mjs";

const cond = (pt, pn, op, pv) => ({ logic: "or", conditions: [{ property_type: pt, property_name: pn, property_compose_type: "origin", property_operation: op, property_values: pv }] });
const IS_TEST = [cond("profile", "is_test", "!=", ["true", ""]), cond("event_param", "isTest", "!=", ["true"])];
const IS_NEW = cond("profile", "user_is_new", "=", [1]); // 值是数字 1，不是 "1"

async function daily(withNew) {
  const start = Math.floor(Date.parse("2026-07-24T05:00:00Z") / 1000);
  const end = Math.floor(Date.parse("2026-07-31T04:59:59Z") / 1000);
  const dsl = {
    use_app_cloud_id: true, app_ids: [BYTEPLUS.appId], version: 3,
    periods: [{ granularity: "day", type: "past_range", timezone: "America/Chicago", week_start: 1,
      spans: [{ type: "timestamp", timestamp: String(start) }, { type: "timestamp", timestamp: String(end) }] }],
    content: {
      profile_groups_v2: [], orders: [], query_type: "event",
      profile_filters: [{ expression: { logic: "and", expressions: withNew ? [...IS_TEST, IS_NEW] : IS_TEST } }],
      queries: [[{ event_name: "pwa_conv_cash_ready_pop_show", event_type: "origin", show_name: "x", groups_v2: [], filters: [],
        show_label: "A", event_indicator: "event_users", measure_info: {}, indicator_show_name: "" }]],
      page: { limit: 1000, offset: 0 }, option: { refresh_cache: false, fusion: false },
    },
  };
  const j = await postAnalysis(dsl);
  if (j.code !== 200) return { err: `${j.code} ${j.message}` };
  const q = j.data?.[0];
  return { dates: (q?.date_index_list || []).map(String), vals: (q?.data_item_list?.[0]?.data || []).map(Number) };
}

const plain = await daily(false);
const fresh = await daily(true);
if (fresh.err) { console.log("加 user_is_new 报错:", fresh.err); process.exit(1); }

// 业务库同期账号创建数（已单独查过）
const DB = { "20260724": 133, "20260725": 150, "20260726": 154, "20260727": 179, "20260728": 219, "20260729": 270, "20260730": 267 };

console.log("注册口径对比（芝加哥日）\n");
console.log("日期        全部弹窗曝光   仅新用户   业务库建号   新用户vs业务库");
plain.dates.forEach((d, i) => {
  const db = DB[d];
  const f = fresh.vals[i];
  const diff = db ? `${f - db >= 0 ? "+" : ""}${f - db}` : "-";
  console.log(`  ${d}  ${String(plain.vals[i]).padStart(9)} ${String(f).padStart(10)} ${String(db ?? "-").padStart(12)} ${diff.padStart(12)}`);
});
const sum = (a) => a.reduce((x, y) => x + y, 0);
console.log(`\n合计      ${String(sum(plain.vals)).padStart(9)} ${String(sum(fresh.vals)).padStart(10)} ${String(sum(Object.values(DB))).padStart(12)}`);
