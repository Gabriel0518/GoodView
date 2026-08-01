// 第三轮：CTR 按渠道拆（看是不是 TikTok 拉低整体），以及落地页/系列版本变化
import { query, end } from "./lib/db.mjs";

const FROM = "2026-06-01", TO = "2026-07-31";
const PWA = `(campaign_name ~* 'pwa|sitin' OR account_name ~* 'pwa|sitin')`;

const weeks = [];
for (let d = new Date(FROM + "T00:00:00Z"); d <= new Date(TO + "T00:00:00Z");) {
  const a = new Date(d), b = new Date(d); b.setUTCDate(b.getUTCDate() + 6);
  weeks.push({ from: a.toISOString().slice(0, 10), to: (b > new Date(TO + "T00:00:00Z") ? new Date(TO + "T00:00:00Z") : b).toISOString().slice(0, 10) });
  d.setUTCDate(d.getUTCDate() + 7);
}

const { rows } = await query(
  `SELECT date::text AS d, channel, SUM(cost)::float8 AS c, SUM(impression)::bigint AS imp, SUM(click)::bigint AS clk
     FROM campaign_daily WHERE date BETWEEN $1 AND $2 AND cost > 0 AND ${PWA} GROUP BY date, channel`, [FROM, TO]);

const f = (v, n = 2) => Number(v).toFixed(n);
console.log("=== 九、CTR / CPC / CPM 按渠道拆 ===");
console.log("周               ┃ facebook: CTR    CPC    CPM  ┃ tiktok: CTR    CPC    CPM");
for (const w of weeks) {
  const g = {};
  for (const r of rows) if (r.d >= w.from && r.d <= w.to) {
    const o = (g[r.channel] ||= { c: 0, imp: 0, clk: 0 });
    o.c += r.c; o.imp += Number(r.imp); o.clk += Number(r.clk);
  }
  const cell = (o) => o && o.imp
    ? `${f(o.clk / o.imp * 100).padStart(5)}% ${f(o.clk ? o.c / o.clk : 0).padStart(6)} ${f(o.imp ? o.c / o.imp * 1000 : 0).padStart(6)}`
    : `    —      —      —`;
  console.log(`${w.from}~${w.to.slice(5)} ┃ ${cell(g.facebook)} ┃ ${cell(g.tiktok)}`);
}

console.log("\n=== 十、系列命名版本（看落地页/玩法是否换过）===");
const { rows: camps } = await query(
  `SELECT campaign_name, MIN(date)::text AS d0, MAX(date)::text AS d1, SUM(cost)::numeric(10,0) AS cost, MAX(channel) AS ch
     FROM campaign_daily WHERE date BETWEEN $1 AND $2 AND cost > 0 AND ${PWA}
    GROUP BY campaign_name HAVING SUM(cost) > 400 ORDER BY MIN(date)`, [FROM, TO]);
for (const r of camps) {
  const tag = /clickbuttongo/i.test(r.campaign_name) ? "[clickbuttongo]"
    : /new_link/i.test(r.campaign_name) ? "[new_link]"
    : /link2\.0|link_2\.0/i.test(r.campaign_name) ? "[link2.0]" : "";
  console.log(`  ${String(r.campaign_name).padEnd(48)} ${String(r.ch).padEnd(9)} $${String(r.cost).padStart(6)}  ${r.d0}~${r.d1} ${tag}`);
}
await end();
