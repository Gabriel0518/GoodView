// 探针：XMP geo 维度粒度（国家 or 州？）+ 系列名含 texas 的花费，决定"德州花费"怎么取
import { fetchReport } from "./lib/xmp.mjs";
import { query, end } from "./lib/db.mjs";

const ymd = (d) => d.toISOString().slice(0, 10);
const to = new Date();
const from = new Date();
from.setDate(from.getDate() - 7);

const { rows: cfg } = await query(
  `SELECT value FROM xmp_fetch_config WHERE category='account' AND enabled
     AND (group_name IS NULL OR group_name NOT ILIKE '%上架包%')`,
);
const accSet = new Set(cfg.map((r) => r.value));

console.log("== 1) geo 维度（date × geo）");
try {
  const g = await fetchReport({ startDate: ymd(from), endDate: ymd(to), dimension: ["date", "geo"], metrics: ["cost"] });
  const byGeo = new Map();
  for (const r of g) {
    if (!accSet.has(String(r.account_id))) continue;
    byGeo.set(r.geo ?? "(空)", (byGeo.get(r.geo ?? "(空)") || 0) + (Number(r.cost) || 0));
  }
  console.log("   PWA 账户 geo 取值数:", byGeo.size);
  [...byGeo.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
    .forEach(([k, v]) => console.log(`     ${String(k).padEnd(20)} $${v.toFixed(2)}`));
} catch (e) {
  console.log("   ❌ geo 维度失败：", e.message);
}

console.log("\n== 2) 系列名含 texas 的花费（date × campaign_name × channel）");
const c = await fetchReport({
  startDate: ymd(from), endDate: ymd(to),
  dimension: ["date", "account_name", "campaign_id", "campaign_name"], metrics: ["cost"],
});
const tx = new Map(), all = new Map();
for (const r of c) {
  if (!accSet.has(String(r.account_id))) continue;
  const ch = r.module || "-";
  const cost = Number(r.cost) || 0;
  all.set(ch, (all.get(ch) || 0) + cost);
  if (/texas|\btx\b/i.test(r.campaign_name || "")) tx.set(ch, (tx.get(ch) || 0) + cost);
}
for (const ch of new Set([...all.keys()])) {
  console.log(`   ${ch.padEnd(10)} 德州系列 $${(tx.get(ch) || 0).toFixed(2).padStart(9)}  /  全部 $${(all.get(ch) || 0).toFixed(2).padStart(9)}`);
}
console.log(`   合计       德州系列 $${[...tx.values()].reduce((a, b) => a + b, 0).toFixed(2)}  /  全部 $${[...all.values()].reduce((a, b) => a + b, 0).toFixed(2)}`);

await end();
