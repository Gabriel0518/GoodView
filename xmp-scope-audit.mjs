// 一次性核对：XMP 近 3 天全量有花费账户 vs 飞书白名单，找漏配的 PWA/公会/上架包账户
import { fetchReport } from "./lib/xmp.mjs";
import { query, end } from "./lib/db.mjs";

const ymd = (d) => d.toISOString().slice(0, 10);
const to = new Date();
const from = new Date();
from.setDate(from.getDate() - 3);

const rows = await fetchReport({
  startDate: ymd(from), endDate: ymd(to),
  dimension: ["date", "account_name", "campaign_id", "campaign_name"], metrics: ["cost"],
});

const byAcct = new Map();
for (const r of rows) {
  const key = `${r.account_id}|${r.account_name || ""}`;
  const e = byAcct.get(key) || { cost: 0, camps: new Set() };
  e.cost += Number(r.cost) || 0;
  if (Number(r.cost) > 0) e.camps.add(r.campaign_name || r.campaign_id);
  byAcct.set(key, e);
}

const { rows: wl } = await query(
  `SELECT category, value FROM xmp_fetch_config WHERE enabled AND category IN ('account','campaign')`,
);
const wlAcc = new Set(wl.filter((r) => r.category === "account").map((r) => r.value));
const wlCamp = new Set(wl.filter((r) => r.category === "campaign").map((r) => r.value));
const wlCampAcc = new Set(); // 白名单系列所属账户（这些账户的该系列在抓取范围内）
for (const r of rows) if (wlCamp.has(String(r.campaign_id))) wlCampAcc.add(r.account_id);

const inScope = (id) => wlAcc.has(id) || wlCampAcc.has(id);
const list = [...byAcct.entries()]
  .map(([k, v]) => ({ id: k.split("|")[0], name: k.split("|")[1], ...v }))
  .filter((x) => x.cost > 0)
  .sort((a, b) => b.cost - a.cost);

console.log(`XMP 近3天有花费账户 ${list.length} 个，其中在抓取范围内 ${list.filter((x) => inScope(x.id)).length} 个`);

console.log(`\n=== 范围外、名字疑似本项目（pwa/sitin/公会/SR/Smart）的账户 → 可能漏配 ===`);
let n = 0;
for (const x of list) {
  if (inScope(x.id)) continue;
  if (!/pwa|sitin|公会|工会|guild|SR_|Smart/i.test(x.name)) continue;
  n++;
  console.log(`  ${x.name.padEnd(28)} ${x.id.padEnd(20)} $${x.cost.toFixed(2).padStart(9)}  系列: ${[...x.camps].slice(0, 3).join(" / ").slice(0, 80)}`);
}
if (!n) console.log("  （无）");

console.log(`\n=== 范围外 top 8 花费账户（应为别产品噪音）===`);
list.filter((x) => !inScope(x.id)).slice(0, 8)
  .forEach((x) => console.log(`  ${x.name.padEnd(28)} ${x.id.padEnd(20)} $${x.cost.toFixed(2).padStart(9)}  ${[...x.camps].slice(0, 2).join(" / ").slice(0, 60)}`));

console.log(`\n=== 范围内账户的德州系列（系列名含 texas/tx）===`);
const tx = rows.filter((r) => inScope(r.account_id) && /texas|_tx\b|-tx\b/i.test(r.campaign_name || ""));
const txAgg = new Map();
for (const r of tx) {
  const k = `${r.account_name}|${r.campaign_name}`;
  txAgg.set(k, (txAgg.get(k) || 0) + (Number(r.cost) || 0));
}
[...txAgg.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k.padEnd(70)} $${v.toFixed(2)}`));
if (!txAgg.size) console.log("  （无）");

await end();
