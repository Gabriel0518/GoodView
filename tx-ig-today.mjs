// 今日德州 IG 绑定 —— 两个时区口径都给，BytePlus(看板口径) + 业务库(交叉验证)
import { query as dms } from "./lib/dms.mjs";
import { postAnalysis, REGION_EXPRS } from "./lib/byteplus.mjs";
import { BYTEPLUS } from "./config.mjs";

const now = new Date();
const day = (c, tz) => `((${c} AT TIME ZONE 'UTC') AT TIME ZONE '${tz}')::date`;

async function bp(tz, region) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, year: "numeric",
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(now).reduce((a, x) => ((a[x.type] = x.value), a), {});
  const off = Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - now.getTime()) / 60000);
  const start = Math.floor((Date.parse(today + "T00:00:00Z") - off * 60000) / 1000);
  const q = await postAnalysis({
    use_app_cloud_id: true, app_ids: [BYTEPLUS.appId], version: 3,
    periods: [{ granularity: "day", type: "past_range", timezone: tz,
      spans: [{ type: "timestamp", timestamp: String(start) },
              { type: "timestamp", timestamp: String(Math.floor(now.getTime() / 1000)) }] }],
    content: {
      profile_groups_v2: [],
      profile_filters: [{ expression: { logic: "and", expressions: [
        { prop: "is_test", prop_type: "profile", op: "!=", values: ["true", ""] },
        { prop: "isTest", prop_type: "profile", op: "!=", values: ["true"] },
        ...(region || []),
      ] } }],
      orders: [], query_type: "event",
      queries: [[{ event_name: "pwa_task_complete", event_type: "origin", show_name: "pwa_task_complete",
        groups_v2: [], filters: [{ prop: "task_id", prop_type: "event", op: "=", values: ["110"] }],
        show_label: "A", event_indicator: "event_users", measure_info: {}, indicator_show_name: "" }]],
      page: { limit: 1000, offset: 0 }, option: { refresh_cache: true, fusion: false },
    },
  });
  const r = q?.data ?? q;
  return (r?.data_item_list?.[0]?.data || []).reduce((a, x) => a + (Number(x) || 0), 0);
}

for (const tz of ["America/Chicago", "Asia/Shanghai"]) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
  const hh = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, hour: "2-digit" }).format(now));
  console.log(`\n=== ${tz}  今天 = ${today}，已走 ${hh} 小时 ===`);
  const d = await dms(`
    SELECT count(DISTINCT t.user_id) n
      FROM user_common_task t JOIN userinfo u ON u.user_id=t.user_id AND u.app_name='3'
     WHERE t.task_id='110' AND t.status='FINISHED'
       AND ${day("t.update_at", tz)} = '${today}'`);
  console.log(`  全量 IG绑定（业务库）      ${d[0].n}`);
  try {
    const all = await bp(tz, null), tx = await bp(tz, REGION_EXPRS.TX);
    console.log(`  全量 IG绑定（BytePlus）    ${all}`);
    console.log(`  德州 IG绑定（BytePlus）    ${tx}${all > 0 ? `   占 ${(tx / all * 100).toFixed(1)}%` : ""}`);
  } catch (e) { console.log(`  BytePlus 查询失败：${e.message.slice(0, 100)}`); }
}
console.log(`\n注：德州拆分只能用 BytePlus —— 业务库 user_geo_location.province 有效值覆盖率 7/28 后掉到 66%，会系统性低估。`);
