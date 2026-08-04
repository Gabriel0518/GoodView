// 白名单账户逐个对账：XMP 有没有花费 vs 库里有没有存
import { fetchReport } from "./lib/xmp.mjs";
import { query, end } from "./lib/db.mjs";

const D = process.argv[2] || "2026-08-03";
const { rows: wl } = await query(
  `SELECT value, name, group_name FROM xmp_fetch_config WHERE category='account' AND enabled ORDER BY group_name, value`);
const white = new Map(wl.map((r) => [r.value, r]));

const raw = await fetchReport({
  startDate: D, endDate: D,
  dimension: ["date", "account_name", "campaign_id", "campaign_name"], metrics: ["cost"],
});
const xmp = new Map();
for (const r of raw) {
  const id = String(r.account_id);
  if (!white.has(id)) continue;
  const o = xmp.get(id) || { name: r.account_name || "", cost: 0, camps: new Map() };
  const c = Number(r.cost) || 0; o.cost += c;
  if (r.campaign_id) {
    const k = String(r.campaign_id);
    o.camps.set(k, { name: r.campaign_name || "", cost: (o.camps.get(k)?.cost || 0) + c });
  }
  if (r.account_name) o.name = r.account_name;
  xmp.set(id, o);
}

const { rows: db } = await query(
  `SELECT account_id, campaign_id, sum(cost) cost FROM campaign_daily WHERE date=$1 GROUP BY 1,2`, [D]);
const dbAcc = new Map();
for (const r of db) {
  const o = dbAcc.get(r.account_id) || { cost: 0, camps: new Set() };
  o.cost += Number(r.cost); o.camps.add(String(r.campaign_id)); dbAcc.set(r.account_id, o);
}

console.log(`=== ${D} 白名单 ${white.size} 个账户对账 ===\n`);
console.log("account_id            归属    XMP花费     库花费    XMP系列/库系列  账户名");
const problems = [];
for (const [id, w] of white) {
  const x = xmp.get(id), d = dbAcc.get(id);
  const xc = x ? [...x.camps.values()].filter((c) => c.cost > 0).length : 0;
  const dc = d ? d.camps.size : 0;
  const xcost = x?.cost || 0, dcost = d?.cost || 0;
  if (xcost === 0 && dcost === 0) continue;              // 双方都没数，正常（未开投）
  const bad = Math.abs(xcost - dcost) > 0.01 || xc !== dc;
  if (bad) problems.push({ id, w, x, d, xc, dc, xcost, dcost });
  console.log(`${id.padEnd(21)} ${String(w.group_name || "PWA").padEnd(6)} ${("$" + xcost.toFixed(2)).padStart(10)} ${("$" + dcost.toFixed(2)).padStart(10)}   ${String(xc).padStart(3)}/${String(dc).padEnd(3)}  ${bad ? "⚠️" : "  "}   ${w.name || x?.name || ""}`);
}
const noSpend = [...white.keys()].filter((id) => !(xmp.get(id)?.cost > 0) && !(dbAcc.get(id)?.cost > 0));
console.log(`\n双方都无花费（未开投）：${noSpend.length} 个`);

if (problems.length) {
  console.log(`\n⚠️ 有差异 ${problems.length} 个：`);
  for (const p of problems) {
    console.log(`\n  ${p.id} ${p.w.name || p.x?.name || ""}  XMP $${p.xcost.toFixed(2)} / 库 $${p.dcost.toFixed(2)}`);
    if (p.x) for (const [cid, c] of p.x.camps) {
      if (c.cost <= 0) continue;
      if (!p.d || !p.d.camps.has(cid)) console.log(`     库里缺系列：${cid}  $${c.cost.toFixed(2)}  ${c.name}`);
    }
  }
} else console.log(`\n✅ 白名单账户全部对得上，没有漏抓。`);
await end();
