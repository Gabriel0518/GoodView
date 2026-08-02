// AI公会 7/27~8/1（到 8/2 00:00）花费核对 + 漏斗
import { query, end } from "./lib/db.mjs";

const FROM = "2026-07-27", TO = "2026-08-02"; // 与用户 XMP 口径一致（含 8/2，合计 $417.68 已核对）
const SRC = ["AIguild", "AIguild_active", "AIguild_passive"];

// 1) 花费：AI公会分组的系列
const { rows: camps } = await query(
  `SELECT jsonb_array_elements(members)->>'id' AS id, jsonb_array_elements(members)->>'name' AS nm
     FROM ad_groups WHERE name ~* 'AI公会|AIguild|公会'`);
const ids = [...new Set(camps.map((c) => c.id))];
console.log(`AI公会系列 ${ids.length} 个: ${camps.map((c) => c.nm).join(" / ")}\n`);

// 按【账户】取而不是按分组取：8/1 新起的 0801_Customer Form_and 还没加进 ad_groups，
// 按分组会漏掉 $135.57。账户口径能自动覆盖新系列。
const ACC = ["26222767373975427", "825268410518087"];
const { rows: sp } = await query(
  `SELECT to_char(date,'YYYY-MM-DD') AS d, campaign_id, MAX(campaign_name) AS nm, MAX(channel) AS ch,
          SUM(cost)::float8 AS cost, SUM(impression)::bigint AS imp, SUM(click)::bigint AS clk
     FROM campaign_daily WHERE date BETWEEN $1 AND $2 AND account_id = ANY($3::text[])
    GROUP BY date, campaign_id HAVING SUM(cost) > 0 ORDER BY date, campaign_id`,
  [FROM, TO, ACC]);
let tot = 0, imp = 0, clk = 0;
console.log("按天×系列花费：");
for (const r of sp) { tot += r.cost; imp += Number(r.imp); clk += Number(r.clk);
  console.log(`  ${r.d}  ${String(r.nm).padEnd(26)} ${String(r.ch).padEnd(9)} $${r.cost.toFixed(2).padStart(8)}  曝光${String(r.imp).padStart(7)} 点击${String(r.clk).padStart(5)}`); }
console.log(`\n合计 $${tot.toFixed(2)}   曝光 ${imp}   点击 ${clk}`);
console.log(`你给的 XMP 数：$417.68   差 $${(tot - 417.68).toFixed(2)}`);

// 2) 漏斗：AI公会三个 source
const { rows: fn } = await query(
  `SELECT m.ord, m.label, m.stage_key, m.event_name,
          SUM(f.count) FILTER (WHERE f.source='AIguild')         AS g,
          SUM(f.count) FILTER (WHERE f.source='AIguild_active')  AS a,
          SUM(f.count) FILTER (WHERE f.source='AIguild_passive') AS p,
          SUM(f.count) AS total
     FROM funnel_daily f JOIN funnel_stage_meta m ON m.stage_key=f.stage_key
    WHERE f.date BETWEEN $1 AND $2 AND f.source = ANY($3::text[])
    GROUP BY m.ord, m.label, m.stage_key, m.event_name
   HAVING SUM(f.count) > 0 ORDER BY m.ord`, [FROM, TO, SRC]);

console.log(`\n=== AI公会转化漏斗 ${FROM} ~ ${TO}（日 UV 求和，含回访）===`);
console.log("序 阶段                          AIguild  active passive   合计");
for (const r of fn) {
  console.log(`${String(r.ord).padStart(2)} ${String(r.label).padEnd(28)} ${String(r.g ?? 0).padStart(7)} ${String(r.a ?? 0).padStart(7)} ${String(r.p ?? 0).padStart(7)} ${String(r.total).padStart(6)}`);
}
if (!fn.length) console.log("  （无数据）");

await end();
