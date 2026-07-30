// 探针：核对德州/非德州细分口径（省份属性、is_test 取值、时区、PV/UV、总量=TX+nonTX）
// 用法：node tx-probe.mjs
import { postAnalysis } from "./lib/byteplus.mjs";
import { BYTEPLUS } from "./config.mjs";

const TX_ID = "4736286";
const DAYS = 7;

const cond = (property_type, property_name, property_operation, property_values) => ({
  logic: "or",
  conditions: [{ property_type, property_name, property_compose_type: "origin", property_operation, property_values }],
});

function period(tz) {
  const now = new Date();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
  const d = new Date(today + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - (DAYS - 1));
  const ymd = d.toISOString().slice(0, 10);
  // tz 偏移
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(now).reduce((a, x) => ((a[x.type] = x.value), a), {});
  const off = Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - now.getTime()) / 60000);
  const start = Math.floor((Date.parse(ymd + "T00:00:00Z") - off * 60000) / 1000);
  return { granularity: "day", type: "past_range", timezone: tz, spans: [{ type: "timestamp", timestamp: String(start) }, { type: "timestamp", timestamp: String(Math.floor(now.getTime() / 1000)) }] };
}

async function run({ event, indicator = "event_users", evFilters = [], profExpr, tz = BYTEPLUS.timezone, groups = [] }) {
  const dsl = {
    use_app_cloud_id: true, app_ids: [BYTEPLUS.appId], version: 3,
    periods: [period(tz)],
    content: {
      profile_groups_v2: groups,
      profile_filters: profExpr ? [{ expression: { logic: "and", expressions: profExpr } }] : [],
      orders: [], query_type: "event",
      queries: [[{ event_name: event, event_type: "origin", show_name: event, groups_v2: [], filters: evFilters, show_label: "A", event_indicator: indicator, measure_info: {}, indicator_show_name: "" }]],
      page: { limit: 1000, offset: 0 },
      option: { refresh_cache: false, fusion: false },
    },
  };
  const j = await postAnalysis(dsl);
  if (j.code !== 200) return { err: `${j.code} ${j.message}` };
  const q = j.data?.[0];
  const items = q?.data_item_list || [];
  return { dates: q?.date_index_list || [], items: items.map((it) => ({ group: it.group_by_key, sum: Number(it.sum) || 0, data: (it.data || []).map(Number) })) };
}

const IS_TEST_STRICT = [cond("profile", "is_test", "!=", ["true", ""]), cond("event_param", "isTest", "!=", ["true"])];
const IS_TEST_LOOSE = [cond("profile", "is_test", "!=", ["true"]), cond("event_param", "isTest", "!=", ["true"])];
const TX = cond("profile", "loc_province_id", "=", [TX_ID]);
const NOT_TX = cond("profile", "loc_province_id", "!=", [TX_ID]);

const EV = { event: "pwa_conv_cash_ready_pop_show" }; // 用户注册

console.log(`== 1) is_test 取值差异（注册, ${DAYS}天, tz=${BYTEPLUS.timezone}）`);
const a1 = await run({ ...EV, profExpr: IS_TEST_STRICT });
const a2 = await run({ ...EV, profExpr: IS_TEST_LOOSE });
const a3 = await run({ ...EV });
console.log("  strict(true,'') =", a1.items?.[0]?.sum, "| loose(true) =", a2.items?.[0]?.sum, "| 无过滤 =", a3.items?.[0]?.sum);

console.log(`\n== 2) 德州 / 非德州 / 全量（注册, strict 过滤）`);
const t = await run({ ...EV, profExpr: [...IS_TEST_STRICT, TX] });
const n = await run({ ...EV, profExpr: [...IS_TEST_STRICT, NOT_TX] });
console.log("  TX =", t.items?.[0]?.sum, "| !=TX =", n.items?.[0]?.sum, "| 全量 =", a1.items?.[0]?.sum,
  "| TX+!=TX =", (t.items?.[0]?.sum || 0) + (n.items?.[0]?.sum || 0));

console.log(`\n== 3) 按 loc_province_id 分组 top（注册, strict）`);
const g = await run({ ...EV, profExpr: IS_TEST_STRICT, groups: [{ property_type: "profile", property_name: "loc_province_id" }] });
(g.items || []).sort((x, y) => y.sum - x.sum).slice(0, 8).forEach((i) => console.log("   ", i.group, i.sum));
console.log("  分组行数 =", g.items?.length, "分组合计 =", (g.items || []).reduce((s, i) => s + i.sum, 0));

console.log(`\n== 4) 省份名分组（loc_province，若存在）`);
const g2 = await run({ ...EV, profExpr: IS_TEST_STRICT, groups: [{ property_type: "profile", property_name: "loc_province" }] });
if (g2.err) console.log("   ", g2.err);
else (g2.items || []).sort((x, y) => y.sum - x.sum).slice(0, 8).forEach((i) => console.log("   ", i.group, i.sum));

console.log(`\n== 5) 时区差异（TX 注册：Asia/Shanghai vs America/Chicago）`);
const tzS = await run({ ...EV, profExpr: [...IS_TEST_STRICT, TX], tz: "Asia/Shanghai" });
const tzC = await run({ ...EV, profExpr: [...IS_TEST_STRICT, TX], tz: "America/Chicago" });
console.log("  Shanghai:", JSON.stringify(tzS.items?.[0]?.data), "sum", tzS.items?.[0]?.sum);
console.log("  Chicago :", JSON.stringify(tzC.items?.[0]?.data), "sum", tzC.items?.[0]?.sum);

console.log(`\n== 6) 成材 PV vs UV（withdraw_amount=25, TX / 全量）`);
const wdFilter = [{ expression: { logic: "and", expressions: [cond("event_param", "withdraw_amount", "=", [25])] } }];
for (const [lbl, prof] of [["全量", IS_TEST_STRICT], ["TX", [...IS_TEST_STRICT, TX]]]) {
  const pv = await run({ event: "pwa_withdraw_audit_apply", indicator: "events", evFilters: wdFilter, profExpr: prof });
  const uv = await run({ event: "pwa_withdraw_audit_apply", indicator: "event_users", evFilters: wdFilter, profExpr: prof });
  console.log(`  ${lbl}: PV=${pv.items?.[0]?.sum} UV=${uv.items?.[0]?.sum}`);
}
