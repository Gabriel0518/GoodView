// 把 AI公会账户下、还没进「PWA AI公会」分组的系列补进去（幂等，可重复跑）。
//
// 背景：AI公会的系列会不定期新起（0617→0714→0801…），漏加就会让 AI公会日报/汇总少算花费
// （2026-08-02 发现 0801_Customer Form_and 漏配，6 天里漏了 $135.57 = 32%）。
// 判定规则：AI公会账户下、系列名匹配 Customer Form / web_text / 公会 的，都算 AI公会。
// 用法：node fix-aiguild-group.mjs [--dry]
import { query, end } from "./lib/db.mjs";

const DRY = process.argv.includes("--dry");
const ACC = ["26222767373975427", "825268410518087"]; // pwa-2026-02 / 省广_AI工会_web_1_wcx_0630
const PATTERN = "customer form|web_text|公会|aiguild";

const { rows: grp } = await query(
  `SELECT id, name, members FROM ad_groups WHERE name ~* 'AI公会|AIguild|公会' LIMIT 1`);
if (!grp.length) { console.error("找不到 AI公会分组"); process.exit(1); }
const g = grp[0];
const have = new Map((g.members || []).map((m) => [String(m.id), m]));
console.log(`分组「${g.name}」(id=${g.id}) 现有 ${have.size} 个系列`);

// 账户下所有匹配的系列（含从未花费的，避免刚建还没跑就漏）
const { rows: found } = await query(
  `SELECT campaign_id AS id, MAX(campaign_name) AS name,
          SUM(cost)::numeric(10,2) AS cost, MIN(date)::text AS d0, MAX(date)::text AS d1
     FROM campaign_daily
    WHERE account_id = ANY($1::text[]) AND campaign_name ~* $2
    GROUP BY campaign_id ORDER BY MIN(date)`, [ACC, PATTERN]);

// 只自动补【分组建立之后】才开始投的系列。更早的老系列不动——把它们加进去会回溯改变
// 历史 AI公会 数字（分组 2026-07-08 建立时就是有意从那时起算的），要不要补由人判断。
const { rows: cg } = await query(`SELECT created_at::date::text AS d FROM ad_groups WHERE id = $1`, [g.id]);
const CUTOFF = cg[0].d;
const add = [], legacy = [];
for (const c of found) {
  if (have.has(String(c.id))) { console.log(`  ✅ 已在分组  ${String(c.name).padEnd(26)} $${c.cost}`); continue; }
  if (c.d0 < CUTOFF) { legacy.push(c); continue; }
  add.push({ id: String(c.id), name: c.name, type: "campaign" });
  console.log(`  ➕ 待加入    ${String(c.name).padEnd(26)} $${c.cost}  ${c.d0}~${c.d1}`);
}
if (legacy.length) {
  console.log(`\n⚠️ 另有 ${legacy.length} 个【分组建立(${CUTOFF})之前】的老系列，未自动加入（加了会回溯改历史）：`);
  legacy.forEach((c) => console.log(`     ${String(c.name).padEnd(26)} $${c.cost}  ${c.d0}~${c.d1}`));
  console.log(`   要补的话：node fix-aiguild-group.mjs --include-legacy`);
}
if (process.argv.includes("--include-legacy")) {
  for (const c of legacy) add.push({ id: String(c.id), name: c.name, type: "campaign" });
}

if (!add.length) { console.log("\n无需改动"); await end(); process.exit(0); }
if (DRY) { console.log("\n--dry：未写入"); await end(); process.exit(0); }

const members = [...(g.members || []), ...add];
await query(`UPDATE ad_groups SET members = $1::jsonb, updated_at = now() WHERE id = $2`,
  [JSON.stringify(members), g.id]);
console.log(`\n✅ 已加入 ${add.length} 个系列，分组现有 ${members.length} 个`);
await end();
