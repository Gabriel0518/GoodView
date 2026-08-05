// 白名单范围内 XMP vs 库 的花费逐账户/逐日差异定位
// 用法：node diff-scope-spend.mjs [天数=30] [--refresh]
// XMP 原始行缓存到 /tmp/xmp-raw-<days>.json，避免反复触发 QPM=10 限频。
import fs from "node:fs";
import { fetchReport } from "./lib/xmp.mjs";
import { query, end } from "./lib/db.mjs";

const DAYS = Number(process.argv[2] || 30);
const REFRESH = process.argv.includes("--refresh");
const ymd = (d) => d.toISOString().slice(0, 10);
const to = new Date(), from = new Date(); from.setDate(from.getDate() - (DAYS - 1));
const D0 = ymd(from), D1 = ymd(to);
const CACHE = `/tmp/xmp-raw-${DAYS}-${D1}.json`;

let raw;
if (!REFRESH && fs.existsSync(CACHE)) {
  raw = JSON.parse(fs.readFileSync(CACHE, "utf8"));
  console.log(`[缓存] ${CACHE} ${raw.length} 行`);
} else {
  raw = await fetchReport({
    startDate: D0, endDate: D1,
    dimension: ["date", "account_name", "campaign_id", "campaign_name"], metrics: ["cost"],
  });
  fs.writeFileSync(CACHE, JSON.stringify(raw));
  console.log(`[XMP] 拉到 ${raw.length} 行 → 缓存 ${CACHE}`);
}

// 白名单（和 fetch-snapshot 一样的 id/名称双向匹配）
const { rows: cfg } = await query(`SELECT category, value, name, group_name FROM xmp_fetch_config WHERE enabled`);
const accKeys = new Set(cfg.filter((r) => r.category === "account").flatMap((r) => [r.value, r.name].filter(Boolean)));
const campKeys = new Set(cfg.filter((r) => r.category === "campaign").flatMap((r) => [r.value, r.name].filter(Boolean)));
const groupOf = new Map(cfg.filter((r) => r.category === "account").map((r) => [r.value, r.group_name || "PWA"]));
const inScope = (r) =>
  accKeys.has(String(r.account_id)) || (r.account_name && accKeys.has(r.account_name)) ||
  campKeys.has(String(r.campaign_id)) || (r.campaign_name && campKeys.has(r.campaign_name));

// XMP 白名单内聚合
const x = new Map();   // acc|camp|date -> cost
const xAcc = new Map(), xDay = new Map();
const nameOf = new Map();
for (const r of raw) {
  if (!inScope(r)) continue;
  const c = Number(r.cost) || 0;
  const acc = String(r.account_id), camp = String(r.campaign_id || "");
  if (r.account_name) nameOf.set(acc, r.account_name);
  x.set(`${acc}|${camp}|${r.date}`, (x.get(`${acc}|${camp}|${r.date}`) || 0) + c);
  xAcc.set(acc, (xAcc.get(acc) || 0) + c);
  xDay.set(r.date, (xDay.get(r.date) || 0) + c);
}

// 库
const { rows: db } = await query(
  `SELECT account_id, campaign_id, date::text d, sum(cost)::float cost
     FROM campaign_daily WHERE date BETWEEN $1 AND $2 GROUP BY 1,2,3`, [D0, D1]);
const y = new Map(), yAcc = new Map(), yDay = new Map();
for (const r of db) {
  y.set(`${r.account_id}|${r.campaign_id}|${r.d}`, Number(r.cost));
  yAcc.set(r.account_id, (yAcc.get(r.account_id) || 0) + Number(r.cost));
  yDay.set(r.d, (yDay.get(r.d) || 0) + Number(r.cost));
}

const xt = [...xAcc.values()].reduce((a, b) => a + b, 0);
const yt = [...yAcc.values()].reduce((a, b) => a + b, 0);
console.log(`\n窗口 ${D0} ~ ${D1}   XMP白名单内 $${xt.toFixed(2)}  库 $${yt.toFixed(2)}  差 $${(yt - xt).toFixed(2)}`);

// 逐账户
console.log(`\n=== 逐账户（|差| > $0.01）===`);
console.log("account_id            归属        XMP花费       库花费        差额   账户名");
const accs = new Set([...xAcc.keys(), ...yAcc.keys()]);
const accDiff = [...accs].map((a) => ({ a, xv: xAcc.get(a) || 0, yv: yAcc.get(a) || 0 }))
  .filter((r) => Math.abs(r.yv - r.xv) > 0.01).sort((p, q) => Math.abs(q.yv - q.xv) - Math.abs(p.yv - p.xv));
for (const r of accDiff) {
  console.log(`${r.a.padEnd(21)} ${String(groupOf.get(r.a) || "—").padEnd(11)} ${("$" + r.xv.toFixed(2)).padStart(10)} ${("$" + r.yv.toFixed(2)).padStart(11)} ${("$" + (r.yv - r.xv).toFixed(2)).padStart(11)}   ${nameOf.get(r.a) || ""}`);
}
if (!accDiff.length) console.log("  （无差异）");

// 逐日
console.log(`\n=== 逐日 ===`);
console.log("日期           XMP       库        差额");
for (const d of [...new Set([...xDay.keys(), ...yDay.keys()])].sort()) {
  const xv = xDay.get(d) || 0, yv = yDay.get(d) || 0;
  const mark = Math.abs(yv - xv) > 0.01 ? " ⚠️" : "";
  console.log(`  ${d} ${("$" + xv.toFixed(2)).padStart(10)} ${("$" + yv.toFixed(2)).padStart(10)} ${("$" + (yv - xv).toFixed(2)).padStart(10)}${mark}`);
}

// 明细：库缺 / 库多
const keys = new Set([...x.keys(), ...y.keys()]);
const missRows = [], extraRows = [];
for (const k of keys) {
  const xv = x.get(k) || 0, yv = y.get(k) || 0;
  if (Math.abs(yv - xv) <= 0.01) continue;
  const [acc, camp, d] = k.split("|");
  (yv < xv ? missRows : extraRows).push({ acc, camp, d, xv, yv });
}
const show = (list, title) => {
  if (!list.length) return;
  list.sort((a, b) => Math.abs(b.yv - b.xv) - Math.abs(a.yv - a.xv));
  console.log(`\n=== ${title} ${list.length} 条（前 25）===`);
  list.slice(0, 25).forEach((r) => console.log(
    `  ${r.d}  ${r.acc.padEnd(21)} ${r.camp.padEnd(20)} XMP $${r.xv.toFixed(2)} / 库 $${r.yv.toFixed(2)}   ${nameOf.get(r.acc) || ""}`));
};
show(missRows, "库里缺/偏少");
show(extraRows, "库里多出（XMP 已无）");
await end();
