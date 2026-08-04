// 8月4日数据（上海时区口径）：投放花费 + AF 事件 + 业务库转化
import { fetchReport } from "./lib/xmp.mjs";
import { query as pg, end } from "./lib/db.mjs";
import { query as dms } from "./lib/dms.mjs";

const D = process.argv[2] || "2026-08-04";
const TZ = "Asia/Shanghai";
console.log(`=== ${D}（上海时区）===\n`);

// 1) 白名单账户花费（XMP）
const { rows: wl } = await pg(
  `SELECT value, name, group_name FROM xmp_fetch_config WHERE category='account' AND enabled`);
const white = new Map(wl.map((r) => [r.value, r]));
const raw = await fetchReport({
  startDate: D, endDate: D,
  dimension: ["date", "account_name", "campaign_id", "campaign_name"], metrics: ["cost", "impression", "click"],
});
const acc = new Map();
for (const r of raw) {
  const id = String(r.account_id);
  if (!white.has(id)) continue;
  const o = acc.get(id) || { name: r.account_name || "", cost: 0, imp: 0, clk: 0, camps: new Map() };
  o.cost += Number(r.cost) || 0; o.imp += Number(r.impression) || 0; o.clk += Number(r.click) || 0;
  if (r.campaign_name && Number(r.cost) > 0) o.camps.set(r.campaign_name, (o.camps.get(r.campaign_name) || 0) + Number(r.cost));
  if (r.account_name) o.name = r.account_name;
  acc.set(id, o);
}
console.log("【投放花费】");
console.log("归属    account_id            花费      曝光     点击   账户名");
const g = { PWA: 0, 上架包: 0 };
for (const [id, v] of [...acc].filter(([, v]) => v.cost > 0).sort((a, b) => b[1].cost - a[1].cost)) {
  const grp = white.get(id).group_name || "PWA";
  g[grp] = (g[grp] || 0) + v.cost;
  console.log(`${grp.padEnd(6)}  ${id.padEnd(21)} ${("$" + v.cost.toFixed(2)).padStart(9)} ${String(v.imp).padStart(8)} ${String(v.clk).padStart(7)}   ${white.get(id).name || v.name}`);
}
console.log(`  小计：PWA $${(g.PWA || 0).toFixed(2)} · 上架包 $${(g["上架包"] || 0).toFixed(2)} · 合计 $${Object.values(g).reduce((a, b) => a + b, 0).toFixed(2)}`);

// 新开投的系列
console.log("\n【当日在投系列】");
for (const [id, v] of [...acc].filter(([, v]) => v.cost > 0)) {
  const grp = white.get(id).group_name || "PWA";
  for (const [cn, c] of [...v.camps].sort((a, b) => b[1] - a[1]))
    console.log(`  ${grp.padEnd(6)} $${c.toFixed(2).padStart(8)}  ${cn}`);
}

// 2) AF 事件（上海日）
console.log("\n【AppsFlyer 事件】");
const { rows: af } = await pg(
  `SELECT app_id, event_name, count(*) n FROM af_events
    WHERE (event_time AT TIME ZONE $2)::date = $1::date GROUP BY 1,2 ORDER BY 1, n DESC`, [D, TZ]);
if (!af.length) console.log("  （无）");
let cur = "";
for (const r of af) {
  if (r.app_id !== cur) { console.log(`  ${r.app_id}:`); cur = r.app_id; }
  console.log(`     ${String(r.event_name).padEnd(34)} ${r.n}`);
}
for (const id of ["com.gracechat.prod-Custom", "com.gigpulse.savvy"])
  if (!af.some((r) => r.app_id === id)) console.log(`  ⚠️ ${id}：当日 0 条（推送未接入）`);

// 3) 业务库转化（上海日）
console.log("\n【业务库转化（PWA）】");
const d = await dms(`
  SELECT
    (SELECT count(*) FROM userinfo WHERE app_name='3'
       AND ((created_at AT TIME ZONE 'UTC') AT TIME ZONE '${TZ}')::date = '${D}') 建号,
    (SELECT count(*) FROM userinfo WHERE app_name='3'
       AND ((created_at AT TIME ZONE 'UTC') AT TIME ZONE '${TZ}')::date = '${D}'
       AND ((email<>'' AND email IS NOT NULL) OR (phone_number<>'' AND phone_number IS NOT NULL))) 有效注册,
    (SELECT count(DISTINCT user_id) FROM user_common_task WHERE task_id='110' AND status='FINISHED'
       AND ((update_at AT TIME ZONE 'UTC') AT TIME ZONE '${TZ}')::date = '${D}') IG绑定,
    (SELECT count(*) FROM user_withdraw_task WHERE amount='25'
       AND ((create_at AT TIME ZONE 'UTC') AT TIME ZONE '${TZ}')::date = '${D}') 成材`);
const x = d[0];
console.log(`  建号 ${x["建号"]} · 有效注册 ${x["有效注册"]} · IG绑定 ${x["ig绑定"] ?? x["IG绑定"] ?? "?"} · 成材 ${x["成材"]}`);
await end();
