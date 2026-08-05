// 抓取配置覆盖度体检：飞书配置 vs XMP 实际 vs Postgres 库
// 回答三件事：①配置表现状 ②XMP 有花费但配置里没有的账户（= 消耗对不齐的主嫌疑）③库 vs XMP 花费差
// 用法：node audit-config-coverage.mjs [天数=30]
import { fetchReport } from "./lib/xmp.mjs";
import { tableIdMap, listRecords, cellStr, cellBool } from "./lib/feishu.mjs";
import { xmpConfigTable } from "./feishu-tables.mjs";
import { query, end } from "./lib/db.mjs";

const DAYS = Number(process.argv[2] || 30);
const F = { ...xmpConfigTable.F, platform: "广告平台" };
const ymd = (d) => d.toISOString().slice(0, 10);
const to = new Date(), from = new Date(); from.setDate(from.getDate() - (DAYS - 1));
const D0 = ymd(from), D1 = ymd(to);

// ---------- 1) 飞书配置表 ----------
const tableId = (await tableIdMap())[xmpConfigTable.name];
const recs = await listRecords(tableId);
const cfgAcc = new Map(), cfgCamp = new Map(), cfgMetric = [];
for (const rec of recs) {
  const f = rec.fields || {};
  const cat = cellStr(f[F.category]).trim();
  const row = {
    value: cellStr(f[F.value]).trim(), name: cellStr(f[F.name]).trim(),
    group: cellStr(f[F.group]).trim(), plat: cellStr(f[F.platform]).trim(),
    enabled: cellBool(f[F.enabled]), status: cellStr(f[F.status]).trim(),
  };
  if (cat === "广告账户") cfgAcc.set(row.value, row);
  else if (cat === "广告系列") cfgCamp.set(row.value, row);
  else if (cat === "指标") cfgMetric.push(row);
}

console.log(`=== 飞书「XMP抓取配置」现状（${recs.length} 行）===`);
console.log(`广告账户 ${cfgAcc.size}（启用 ${[...cfgAcc.values()].filter((r) => r.enabled).length}） · 广告系列 ${cfgCamp.size} · 指标 ${cfgMetric.length}`);
console.log(`指标：${cfgMetric.map((m) => `${m.value}${m.enabled ? "" : "(停用)"}`).join(" · ")}`);

// ---------- 2) XMP 实际 ----------
const raw = await fetchReport({
  startDate: D0, endDate: D1,
  dimension: ["date", "account_name", "campaign_id", "campaign_name"], metrics: ["cost"],
});
const xmp = new Map();
for (const r of raw) {
  const id = String(r.account_id);
  const o = xmp.get(id) || { name: "", module: "", cost: 0, camps: new Map(), last: "" };
  const c = Number(r.cost) || 0; o.cost += c;
  if (r.account_name) o.name = r.account_name;
  if (r.module) o.module = r.module;
  if (c > 0) {
    if (r.date > o.last) o.last = r.date;
    const cid = String(r.campaign_id || "");
    if (cid) o.camps.set(cid, { name: r.campaign_name || "", cost: (o.camps.get(cid)?.cost || 0) + c });
  }
  xmp.set(id, o);
}
const xmpTotal = [...xmp.values()].reduce((a, o) => a + o.cost, 0);

// 白名单命中：账户命中 或 系列命中（id/名称双向）
const accKeys = new Set([...cfgAcc.values()].filter((r) => r.enabled).flatMap((r) => [r.value, r.name].filter(Boolean)));
const campKeys = new Set([...cfgCamp.values()].filter((r) => r.enabled).flatMap((r) => [r.value, r.name].filter(Boolean)));
const hitAcc = (id, name) => accKeys.has(id) || (name && accKeys.has(name));
let inScope = 0, outScope = 0;
const missing = [];
for (const [id, o] of xmp) {
  if (o.cost <= 0) continue;
  if (hitAcc(id, o.name)) { inScope += o.cost; continue; }
  // 账户没命中：看有没有系列命中
  let campCost = 0;
  for (const [cid, c] of o.camps) if (campKeys.has(cid) || campKeys.has(c.name)) campCost += c.cost;
  inScope += campCost;
  const rest = o.cost - campCost;
  if (rest > 0.005) { outScope += rest; missing.push({ id, ...o, rest }); }
}

console.log(`\n=== XMP 近 ${DAYS} 天（${D0} ~ ${D1}）===`);
console.log(`XMP 全量花费 $${xmpTotal.toFixed(2)}  ·  白名单内 $${inScope.toFixed(2)}  ·  白名单外 $${outScope.toFixed(2)}（${(outScope / xmpTotal * 100).toFixed(1)}%）`);

missing.sort((a, b) => b.rest - a.rest);
if (missing.length) {
  console.log(`\n⚠️ 有花费但不在抓取范围内的账户 ${missing.length} 个（这部分消耗看板里看不到）：`);
  console.log("account_id            平台        未覆盖花费   最后有花费   账户名");
  for (const m of missing) {
    console.log(`${m.id.padEnd(21)} ${(m.module || "—").padEnd(11)} ${("$" + m.rest.toFixed(2)).padStart(11)}   ${(m.last || "—").padEnd(11)} ${m.name}`);
    if (m.rest > 100) [...m.camps.entries()].sort((a, b) => b[1].cost - a[1].cost).slice(0, 4)
      .forEach(([cid, c]) => console.log(`      └ ${cid.padEnd(20)} ${("$" + c.cost.toFixed(2)).padStart(10)}  ${c.name}`));
  }
}

// ---------- 3) 配置里有、XMP 近期无花费 ----------
const idle = [...cfgAcc.entries()].filter(([id, r]) => r.enabled && !(xmp.get(id)?.cost > 0));
if (idle.length) {
  console.log(`\n=== 配置里启用、但近 ${DAYS} 天 XMP 无花费 ${idle.length} 个 ===`);
  idle.forEach(([id, r]) => console.log(`  ${id.padEnd(21)} 归属=${(r.group || "(空)").padEnd(14)} 平台=${(r.plat || "(空)").padEnd(9)} 名称=${r.name || "(空)"}`));
}

// ---------- 4) 元信息缺口 ----------
const gapName = [...cfgAcc.entries()].filter(([id, r]) => r.enabled && !r.name && xmp.get(id)?.name);
const gapGroup = [...cfgAcc.values()].filter((r) => r.enabled && !r.group);
const gapPlat = [...cfgAcc.entries()].filter(([id, r]) => r.enabled && (!r.plat || (xmp.get(id)?.module && r.plat.toLowerCase() !== xmp.get(id).module)));
console.log(`\n=== 元信息缺口 ===`);
console.log(`名称待补 ${gapName.length} · 归属待补 ${gapGroup.length} · 平台待补/不一致 ${gapPlat.length}`);
gapName.forEach(([id, r]) => console.log(`  名称 ${id} → ${xmp.get(id).name}`));
gapGroup.forEach((r) => console.log(`  归属 ${r.value} ${r.name}`));
gapPlat.forEach(([id, r]) => console.log(`  平台 ${id} 配置=${r.plat || "(空)"} XMP=${xmp.get(id)?.module || "—"} ${r.name}`));

// ---------- 5) 库 vs XMP ----------
const { rows: db } = await query(
  `SELECT sum(cost)::float cost, count(*)::int n, min(date)::text d0, max(date)::text d1
     FROM campaign_daily WHERE date BETWEEN $1 AND $2`, [D0, D1]);
console.log(`\n=== Postgres campaign_daily 同窗口 ===`);
console.log(`库花费 $${(db[0].cost || 0).toFixed(2)} · ${db[0].n} 行 · ${db[0].d0} ~ ${db[0].d1}`);
console.log(`库 vs 白名单内 XMP 差 $${((db[0].cost || 0) - inScope).toFixed(2)}`);

const { rows: byDay } = await query(
  `SELECT date::text d, sum(cost)::float cost FROM campaign_daily WHERE date BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 1 DESC LIMIT 10`, [D0, D1]);
const xmpDay = {};
for (const r of raw) xmpDay[r.date] = (xmpDay[r.date] || 0) + (Number(r.cost) || 0);
console.log(`\n最近 10 天 逐日 库 vs XMP全量：`);
console.log("日期          库花费        XMP全量      差额");
for (const r of byDay) {
  const x = xmpDay[r.d] || 0;
  console.log(`  ${r.d}  ${("$" + r.cost.toFixed(2)).padStart(11)} ${("$" + x.toFixed(2)).padStart(12)} ${("$" + (r.cost - x).toFixed(2)).padStart(11)}`);
}
await end();
