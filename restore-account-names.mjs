// 修复：check-account-group.mjs --fix-names 把配置表「名称」列覆写成了 XMP 真实账户名，
// 而这一列是**表名来源**（feishu-tables.mjs:1182 → pwaAccountTable(a.name, a.id)），
// 改名后同步找不到飞书里的原表 → 5 张分账户表同步失败。这里恢复原名。
import { tableIdMap, listTables, listRecords, batchUpdate, cellStr } from "./lib/feishu.mjs";
import { xmpConfigTable } from "./feishu-tables.mjs";

const APPLY = process.argv.includes("--apply");
const F = xmpConfigTable.F;

// 原名 = 飞书里实际存在的分账户表名（有历史数据，不能弃用）
const RESTORE = {
  "2130069727853758":    "省广_pwa_新_8",
  "7408482788221173761": "省广_GC AND_1-ymt（pwa）",
  "7582874867184386064": "省广_GC AND_5-zmf（pwa）",
  "7639625025477623815": "省广_GC_pwa_2_wcx",
  "7639625690962640914": "省广_GC_pwa_1_zmf",
  "7665547836257058834": "省广_SR_and_1-5D80", // 上架包，不生成分账户表，一并恢复保持一致
};

const tabs = new Set((await listTables()).map((t) => t.name));
const tableId = (await tableIdMap())[xmpConfigTable.name];
const updates = [];
for (const rec of await listRecords(tableId)) {
  const f = rec.fields || {};
  const id = cellStr(f[F.value]).trim();
  const want = RESTORE[id];
  if (!want) continue;
  const cur = cellStr(f[F.name]).trim();
  if (cur === want) { console.log(`   已是原名  ${id}  ${want}`); continue; }
  console.log(`   恢复  ${id}  「${cur}」→「${want}」${tabs.has(want) ? "  (飞书有此表 ✅)" : "  (飞书无此表)"}`);
  updates.push({ record_id: rec.record_id, fields: { [F.name]: want } });
}

if (!APPLY) { console.log(`\n[演练] 待恢复 ${updates.length} 行。加 --apply 执行`); process.exit(0); }
if (updates.length) {
  const n = await batchUpdate(tableId, updates);
  console.log(`\n✅ 已恢复 ${n} 行。下一步：node sync-config-from-feishu.mjs && node sync-to-feishu.mjs`);
} else console.log("\n无需恢复。");
