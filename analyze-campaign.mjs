import fs from "node:fs";
const s = JSON.parse(fs.readFileSync("data/snapshot.json", "utf8"));
const cr = s.campaignRows || [];
console.log("总行数:", cr.length, "=> 页数:", Math.ceil(cr.length / 1000));

const byCh = {};
for (const r of cr) byCh[r.channel] = (byCh[r.channel] || 0) + 1;
console.log("\n按渠道行数:", Object.entries(byCh).map(([k, v]) => `${k}=${v}`).join("  "));

const accs = [...new Set(cr.map((r) => r.account_name))];
const isPwa = (a) => /pwa/i.test(a);
console.log("\naccount 总数:", accs.length);
const pwaAccs = accs.filter(isPwa);
console.log("含pwa的account数:", pwaAccs.length, "样例:", pwaAccs.slice(0, 8).join(", "));
console.log("不含pwa样例:", accs.filter((a) => !isPwa(a)).slice(0, 10).join(", "));

const pwaRows = cr.filter((r) => isPwa(r.account_name));
console.log("\n只保留 pwa account: 行数", pwaRows.length, "=> 页数", Math.ceil(pwaRows.length / 1000));

const camps = [...new Set(cr.map((r) => r.campaign_name))];
console.log("\ncampaign 总数:", camps.length, "样例:", camps.slice(0, 6).join(" | "));

const nonzero = cr.filter((r) => r.cost > 0);
console.log("\n花费>0行:", nonzero.length, `(${((nonzero.length / cr.length) * 100).toFixed(0)}%)`);
const cSpend = {};
for (const r of cr) cSpend[r.campaign_id] = (cSpend[r.campaign_id] || 0) + r.cost;
const sorted = Object.values(cSpend).sort((a, b) => b - a);
const total = sorted.reduce((a, b) => a + b, 0);
console.log("Top50系列花费占比:", `${((sorted.slice(0, 50).reduce((a, b) => a + b, 0) / total) * 100).toFixed(1)}%`, "(共", sorted.length, "系列)");
console.log("Top100系列花费占比:", `${((sorted.slice(0, 100).reduce((a, b) => a + b, 0) / total) * 100).toFixed(1)}%`);
