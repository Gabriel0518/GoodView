// 新增广告账户 → 飞书「XMP抓取配置」表（权威源；写完跑 sync-config-from-feishu.mjs 落库）
// 用法：node add-accounts.mjs            # 演练，只打印不写
//       node add-accounts.mjs --apply    # 真正写入
import { tableIdMap, listRecords, batchCreate, cellStr } from "./lib/feishu.mjs";
import { xmpConfigTable } from "./feishu-tables.mjs";
import { CATEGORIES } from "./lib/whitelist.mjs";

const APPLY = process.argv.includes("--apply");
const F = xmpConfigTable.F;

// 归属：'PWA' | '上架包'。改这里即可调整某批账户的归属。
const BATCHES = [
  { group: process.env.GROUP_TT_NEW || "PWA", note: "TikTok 新批(7668...)", ids: [
    "7668624339939524616","7668624955337752594","7668625354855022600","7668624339939590152",
    "7668624396474679303","7668624954805305352","7668625448309424136","7668625286317195282",
    "7668625452341477383","7668625504119832584"] },
  { group: process.env.GROUP_TT_SR || "上架包", note: "TikTok 老批(7665...)", ids: [
    "7665548417193361426","7665548175902425095","7665548460992839688","7665548308890697736",
    "7665547836257058834","7665548376175525895","7665549158183927829","7665548826492616712",
    "7665548936848998407","7665549360232677383"] },
  { group: process.env.GROUP_GG || "上架包", note: "Google", ids: [
    "3219001356","6245583421","2920807796","5125400223"] },
];

const tableId = (await tableIdMap())[xmpConfigTable.name];
if (!tableId) throw new Error(`飞书里没有「${xmpConfigTable.name}」表`);

const existing = new Map();
for (const r of await listRecords(tableId)) {
  const v = cellStr(r.fields?.[F.value]).trim();
  if (v) existing.set(v, { group: cellStr(r.fields?.[F.group]).trim(), name: cellStr(r.fields?.[F.name]).trim() });
}
console.log(`飞书配置表现有 ${existing.size} 行\n`);

const toCreate = [], skipped = [];
for (const b of BATCHES) {
  console.log(`— ${b.note} → 归属「${b.group}」`);
  for (const id of b.ids) {
    const e = existing.get(id);
    if (e) {
      skipped.push({ id, ...e, want: b.group });
      const warn = e.group !== b.group ? `  ⚠️ 归属不一致：飞书=${e.group || "(空)"} 本次=${b.group}` : "";
      console.log(`   已存在  ${id}  归属=${e.group || "(空)"}  ${e.name}${warn}`);
      continue;
    }
    // 注意：batchCreate 内部已包一层 { fields }，这里传扁平字段对象即可
    toCreate.push({
      [F.value]: id,
      [F.category]: CATEGORIES.account,
      [F.group]: b.group,
      [F.enabled]: true,
      // 名称留空：等 XMP 抓到数据后由回填脚本补账户名
    });
    console.log(`   新增    ${id}`);
  }
  console.log("");
}

console.log(`合计：新增 ${toCreate.length} 行 · 已存在跳过 ${skipped.length} 行`);
const conflict = skipped.filter((s) => s.group !== s.want);
if (conflict.length) {
  console.log(`\n⚠️ 归属冲突 ${conflict.length} 个（保持飞书现状，未改动）：`);
  conflict.forEach((s) => console.log(`   ${s.id}  飞书=${s.group || "(空)"}  本次拟填=${s.want}  ${s.name}`));
}

if (!APPLY) { console.log("\n[演练] 未写入。确认无误后加 --apply"); process.exit(0); }
if (toCreate.length) {
  const n = await batchCreate(tableId, toCreate);
  console.log(`\n✅ 已写入飞书 ${n} 行。下一步：node sync-config-from-feishu.mjs`);
} else console.log("\n无新增。");
