// 三端消耗汇总（PWA / SmartReply / Savvy / AI公会），按账户归属 + AI公会系列拆
import { fetchReport } from "./lib/xmp.mjs";
import { query, end } from "./lib/db.mjs";

const DAYS = Number(process.argv[2] || 7);
const ymd = (d) => d.toISOString().slice(0, 10);
const to = new Date(), from = new Date(); from.setDate(from.getDate() - (DAYS - 1));

const { rows: cfg } = await query(`SELECT category, value, name, group_name FROM xmp_fetch_config WHERE enabled`);
const grp = new Map(cfg.filter((r) => r.category === "account").map((r) => [r.value, r.group_name || "PWA"]));
const aiCamp = new Set(cfg.filter((r) => r.category === "campaign" && r.group_name === "AI公会").map((r) => r.value));
const bucket = (accId, campId) => {
  if (aiCamp.has(campId)) return "AI公会";
  const g = grp.get(accId);
  if (g === undefined) return null;
  if (/savvy/i.test(g)) return "Savvy";
  if (/上架包|smart ?reply/i.test(g)) return "SmartReply";
  return "PWA";
};

const raw = await fetchReport({
  startDate: ymd(from), endDate: ymd(to),
  dimension: ["date", "account_name", "campaign_id", "campaign_name"], metrics: ["cost"],
});
const byDay = {}, tot = {};
for (const r of raw) {
  const k = bucket(String(r.account_id), String(r.campaign_id));
  const v = Number(r.cost) || 0;
  if (!k || !v) continue;
  (byDay[r.date] = byDay[r.date] || {})[k] = (byDay[r.date][k] || 0) + v;
  tot[k] = (tot[k] || 0) + v;
}

const K = ["PWA", "SmartReply", "Savvy", "AI公会"];
console.log(`=== 近 ${DAYS} 天消耗（XMP 日期口径）===\n`);
console.log("日期          " + K.map((k) => k.padStart(11)).join("") + "       合计");
for (const d of Object.keys(byDay).sort()) {
  const row = byDay[d];
  const s = K.reduce((a, k) => a + (row[k] || 0), 0);
  console.log(`  ${d}` + K.map((k) => ("$" + (row[k] || 0).toFixed(2)).padStart(11)).join("") + ("$" + s.toFixed(2)).padStart(12));
}
const S = K.reduce((a, k) => a + (tot[k] || 0), 0);
console.log("  " + "合计".padEnd(10) + K.map((k) => ("$" + (tot[k] || 0).toFixed(2)).padStart(11)).join("") + ("$" + S.toFixed(2)).padStart(12));
console.log("\n占比：" + K.map((k) => `${k} ${((tot[k] || 0) / S * 100).toFixed(1)}%`).join(" · "));

console.log(`\n=== 各端账户明细（近 ${DAYS} 天有花费的）===`);
const acc = {};
for (const r of raw) {
  const k = bucket(String(r.account_id), String(r.campaign_id));
  const v = Number(r.cost) || 0;
  if (!k || !v) continue;
  const id = String(r.account_id);
  const o = (acc[k] = acc[k] || {})[id] || { name: r.account_name || "", cost: 0 };
  o.cost += v; if (r.account_name) o.name = r.account_name;
  acc[k][id] = o;
}
for (const k of K) {
  if (!acc[k]) continue;
  const list = Object.entries(acc[k]).sort((a, b) => b[1].cost - a[1].cost);
  console.log(`\n${k}（${list.length} 个账户 · $${(tot[k] || 0).toFixed(2)}）`);
  list.forEach(([id, o]) => console.log(`  ${id.padEnd(21)} ${("$" + o.cost.toFixed(2)).padStart(10)}  ${o.name}`));
}
await end();
