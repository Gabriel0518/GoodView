// 修正飞书「XMP抓取配置」：①补漏配的 PWA 账户 ②停用 XMP 查无数据的幽灵账户行
// 幂等：已存在的账户行不重复加；已停用的不重复改。
// 用法：node fix-config-rows.mjs [--apply]
import { tableIdMap, listRecords, batchCreate, batchUpdate, cellStr, cellBool } from "./lib/feishu.mjs";
import { xmpConfigTable } from "./feishu-tables.mjs";

const APPLY = process.argv.includes("--apply");
const F = { ...xmpConfigTable.F, platform: "广告平台" };

// ① 有花费但从没配进抓取范围的 PWA 账户（2026-08-05 用 audit-config-coverage 扫出来）
//    「名称」= XMP 侧账户名，会成为分账户飞书表的表名 → 建完别再改（见 feishu-tables.mjs 注释）
const ADD = [
  { id: "7639625877946531858", name: "省广_syh_pwa_5",           plat: "TikTok",   group: "PWA" },
  { id: "7639625850052395026", name: "省广_GC_AND_3_(pwa)-syh",  plat: "TikTok",   group: "PWA" },
  { id: "827391417005980",     name: "省广_pwa_新_6_ymt",         plat: "Facebook", group: "PWA" },
  { id: "2947793602222179",    name: "省广_pwa_新_7_zmf",         plat: "Facebook", group: "PWA" },
  { id: "7582874895990964240", name: "省广_GC AND_4-ymt(pwa)",   plat: "TikTok",   group: "PWA" }, // 未开投
];

// ② XMP 近 90 天查无此账户、campaign_daily 历史也从没出现过 → 停用（保留行，便于对照原始来源）
const DISABLE = [
  "7668624339939524616", "7668624955337752594", "7668625354855022600",
  "7668624339939590152", "7668624396474679303", "7668625448309424136",
  "7665548417193361426", "7665548175902425095", "7665548460992839688",
  "7665548308890697736", "7665549158183927829",
];

const tableId = (await tableIdMap())[xmpConfigTable.name];
const recs = await listRecords(tableId);
const byValue = new Map();
for (const r of recs) {
  if (cellStr(r.fields?.[F.category]).trim() !== "广告账户") continue;
  byValue.set(cellStr(r.fields[F.value]).trim(), r);
}

// 新增
const creates = [];
console.log("=== ① 补漏配账户 ===");
for (const a of ADD) {
  if (byValue.has(a.id)) { console.log(`  跳过（已存在）${a.id} ${a.name}`); continue; }
  // batchCreate 收的是「裸 fields 对象」数组，它自己包 { fields }——别再包一层
  creates.push({
    [F.value]: a.id, [F.category]: "广告账户", [F.name]: a.name,
    [F.platform]: a.plat, [F.group]: a.group, [F.enabled]: true,
  });
  console.log(`  新增 ${a.id.padEnd(21)} ${a.plat.padEnd(9)} ${a.group.padEnd(5)} ${a.name}`);
}

// 停用
const updates = [];
console.log("\n=== ② 停用幽灵账户 ===");
for (const id of DISABLE) {
  const rec = byValue.get(id);
  if (!rec) { console.log(`  跳过（配置里没有）${id}`); continue; }
  if (!cellBool(rec.fields[F.enabled])) { console.log(`  跳过（已停用）${id}`); continue; }
  updates.push({ record_id: rec.record_id, fields: {
    [F.enabled]: false,
    [F.status]: "⏸ 已停用：XMP 近90天查无此账户，库里也从无记录（疑似 ID 有误）",
  } });
  console.log(`  停用 ${id}  归属=${cellStr(rec.fields[F.group]) || "(空)"}`);
}

console.log(`\n待新增 ${creates.length} 行 · 待停用 ${updates.length} 行`);
if (!APPLY) { console.log("[演练] 加 --apply 执行"); process.exit(0); }
if (creates.length) console.log(`✅ 新增 ${await batchCreate(tableId, creates)} 行`);
if (updates.length) console.log(`✅ 停用 ${await batchUpdate(tableId, updates)} 行`);
console.log("下一步：node sync-config-from-feishu.mjs → node feishu-init-tables.mjs → node pull-all.mjs 30");
