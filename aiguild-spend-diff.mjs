// 找差额：AI公会账户下 7/27~8/1 的全部系列（不限分组），看有没有漏配的
import { query, end } from "./lib/db.mjs";

const FROM = "2026-07-27", TO = "2026-08-01";
// AI公会已知账户：pwa-2026-02(跑 Customer Form 系列) + 省广_AI工会_web_1_wcx_0630
const ACC = ["26222767373975427", "825268410518087"];

const { rows: g } = await query(
  `SELECT jsonb_array_elements(members)->>'id' AS id FROM ad_groups WHERE name ~* 'AI公会|AIguild|公会'`);
const inGroup = new Set(g.map((r) => r.id));

const { rows } = await query(
  `SELECT campaign_id, MAX(campaign_name) AS nm, MAX(account_name) AS acct, MAX(channel) AS ch,
          SUM(cost)::float8 AS cost, MIN(date)::text AS d0, MAX(date)::text AS d1
     FROM campaign_daily WHERE date BETWEEN $1 AND $2 AND account_id = ANY($3::text[]) AND cost > 0
    GROUP BY campaign_id ORDER BY cost DESC`, [FROM, TO, ACC]);

console.log(`AI公会账户下 ${FROM}~${TO} 有花费的系列：`);
let inG = 0, outG = 0;
for (const r of rows) {
  const mark = inGroup.has(r.campaign_id) ? "✅在分组" : "❌不在分组";
  if (inGroup.has(r.campaign_id)) inG += r.cost; else outG += r.cost;
  console.log(`  ${mark}  ${String(r.nm).padEnd(28)} ${String(r.ch).padEnd(9)} $${r.cost.toFixed(2).padStart(8)}  ${r.d0}~${r.d1}  ${r.acct}`);
}
console.log(`\n在分组内 $${inG.toFixed(2)} · 不在分组 $${outG.toFixed(2)} · 账户合计 $${(inG + outG).toFixed(2)}`);
console.log(`你给的 XMP 数 $417.68`);

// 再看：是不是别的账户也在跑 Customer Form / 公会类系列
const { rows: other } = await query(
  `SELECT campaign_id, MAX(campaign_name) AS nm, MAX(account_name) AS acct, SUM(cost)::float8 AS cost
     FROM campaign_daily WHERE date BETWEEN $1 AND $2 AND cost > 0
       AND (campaign_name ~* 'customer form|web_text|公会|guild')
       AND NOT (account_id = ANY($3::text[]))
    GROUP BY campaign_id ORDER BY cost DESC`, [FROM, TO, ACC]);
if (other.length) {
  console.log(`\n⚠️ 其它账户下的公会类系列：`);
  other.forEach((r) => console.log(`  ${String(r.nm).padEnd(28)} $${r.cost.toFixed(2).padStart(8)}  ${r.acct}`));
}
await end();
