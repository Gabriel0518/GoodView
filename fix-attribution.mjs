// 归属修正：4 个 Savvy 账户移出 PWA + 2 个新 AI公会系列补进配置
// 飞书是权威源（sync-config-from-feishu 会 DELETE 全表重插），所以写飞书
// 用法：node fix-attribution.mjs [--apply]
import { tableIdMap, listRecords, batchCreate, batchUpdate, cellStr } from "./lib/feishu.mjs";
import { xmpConfigTable } from "./feishu-tables.mjs";
import { CATEGORIES } from "./lib/whitelist.mjs";

const APPLY = process.argv.includes("--apply");
const F = xmpConfigTable.F;

// 归属写「上架包(Savvy)」而不是「上架包」：
//   · APP_GROUP_SQL 是 ~* '上架包|smart ?reply'，带括号后缀照样匹配 → 一样从 PWA 口径剔除
//   · 但在配置表里能和 SmartReply 区分开，将来要拆分产品时不用再考古
const SAVVY = [
  ["7668625504119832584", "省广_Savvyand_1-syh"],
  ["7668625452341477383", "省广_Savvyand_2-syh"],
  ["7668625286317195282", "省广_Savvyand_3-syh"],
  ["7668624954805305352", "省广_Savvyand_5-syh"],
];
const AIGUILD = [
  ["120253187782990085", "0801_Customer Form_and"],
  ["120253251837050085", "0804_Customer Form_and"],
];

const tableId = (await tableIdMap())[xmpConfigTable.name];
const recs = await listRecords(tableId);
const byValue = new Map();
for (const r of recs) {
  const v = cellStr(r.fields?.[F.value]).trim();
  if (v) byValue.set(v, r);
}

const updates = [], creates = [];
console.log("=== 1. Savvy 账户归属：PWA → 上架包(Savvy) ===");
for (const [id, name] of SAVVY) {
  const rec = byValue.get(id);
  if (!rec) { console.log(`  ⚠️ ${id} 不在配置表里，跳过`); continue; }
  const cur = cellStr(rec.fields?.[F.group]).trim();
  if (cur === "上架包(Savvy)") { console.log(`  已是目标值  ${id}  ${name}`); continue; }
  console.log(`  ${id}  「${cur || "(空)"}」→「上架包(Savvy)」  ${name}`);
  updates.push({ record_id: rec.record_id, fields: { [F.group]: "上架包(Savvy)", [F.name]: name } });
}

console.log("\n=== 2. 新 AI公会系列补进配置 ===");
for (const [id, name] of AIGUILD) {
  if (byValue.has(id)) { console.log(`  已存在  ${id}  ${name}`); continue; }
  console.log(`  新增    ${id}  ${name}`);
  creates.push({ [F.value]: id, [F.category]: CATEGORIES.campaign, [F.name]: name,
    [F.group]: "AI公会", [F.enabled]: true });
}

console.log(`\n合计：改归属 ${updates.length} 行 · 新增系列 ${creates.length} 行`);
if (!APPLY) { console.log("\n[演练] 未写入。确认后加 --apply"); process.exit(0); }
if (updates.length) console.log(`✅ 更新 ${await batchUpdate(tableId, updates)} 行`);
if (creates.length) console.log(`✅ 新增 ${await batchCreate(tableId, creates)} 行`);
console.log("\n下一步：node sync-config-from-feishu.mjs");
