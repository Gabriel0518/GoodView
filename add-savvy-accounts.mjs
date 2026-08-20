// Savvy 广告账户补录：新增漏配的账户 + 修正归属写错的账户。
// 依据 savvy-account-scan.mjs 的扫描结果（XMP 近 14 天实际在投 vs 配置白名单）。
//
// 飞书「XMP抓取配置」是**唯一权威源** —— sync-config-from-feishu 会 DELETE 整张
// xmp_fetch_config 再重插，所以只能写飞书，直接改 Postgres 会在下一轮被抹掉。
//
// 用法：node add-savvy-accounts.mjs            # 演练，只打印不写
//       node add-savvy-accounts.mjs --apply    # 真正写入
// 写完接：node sync-config-from-feishu.mjs && node fetch-snapshot.mjs 20
import { tableIdMap, listRecords, batchCreate, batchUpdate, cellStr } from "./lib/feishu.mjs";
import { xmpConfigTable } from "./feishu-tables.mjs";
import { CATEGORIES } from "./lib/whitelist.mjs";

const APPLY = process.argv.includes("--apply");
const F = { ...xmpConfigTable.F, platform: "广告平台" };
const GROUP = "上架包(Savvy)"; // 带括号后缀：APP_GROUP_SQL 的 ~* '上架包|smart ?reply' 照样命中
                              // （= 一样从 PWA 口径剔除），但能和 SmartReply 区分开。
                              // ⚠️ lib/xiaomei.mjs 的 PRODUCT_CASE_SQL 里 savvy 必须排在 SmartReply 前面。

// ① 新增：XMP 近 14 天在投、但配置表里完全没有的 Savvy 账户。
//    ⚠️ 前两个的**账户名里没有 "savvy"**（QQ-TZCH-3A-0806+8-05/06），是靠系列名认出来的
//       —— 同名系列 QQ-TZCH-3A-0806+8-04 是 SmartReply 的账户，同一批号段跨了两个产品，
//       以后加账户不能只看账户名。
const NEW = [
  { id: "1705039667380971",   name: "QQ-TZCH-3A-0806+8-06", plat: "Facebook", note: "$736.44 · 08-17起 · Savvy-小美-wei-0816 / Savvy-安装-wei-0818" },
  { id: "1251481510358161",   name: "QQ-TZCH-3A-0806+8-05", plat: "Facebook", note: "$81.55 · 08-19起 · Savvy-wei-install-IOS-0818" },
  { id: "7669702206987714581", name: "省广_Savvyios_wei_-01", plat: "TikTok",  note: "$74.52 · 08-19起 · Savvy-IOS-wei-install-0819" },
];

// ② 改归属：配置里挂着 上架包(SmartReply)，但账户早已改投 Savvy。
//    已核对 campaign_daily 全部历史：这两个户**从头到尾只跑过 Savvy 系列**（2026-08-04 起），
//    所以直接改归属不会把过去的 SmartReply 花费误划到 Savvy —— 它们根本没有 SmartReply 历史。
//    配置里的旧名（AI Fantasy-*）是建号时留下的，XMP 现在报的名字已经是 省广_Savvyand_wei-0x。
const REGROUP = [
  { id: "5125400223", name: "省广_Savvyand_wei-04", plat: "Google", note: "$3113.91 累计 · 系列 savvy_and_wei_install_0804_gg" },
  { id: "2920807796", name: "省广_Savvyand_wei-03", plat: "Google", note: "$778.43 累计 · 系列 Savvy_pwa_wei_0804-1" },
];

const tableId = (await tableIdMap())[xmpConfigTable.name];
const recs = await listRecords(tableId);
const byValue = new Map();
for (const r of recs) {
  const v = cellStr(r.fields?.[F.value]).trim();
  if (v) byValue.set(v, r);
}

const creates = [], updates = [];

console.log("=== ① 新增 Savvy 广告账户 ===");
for (const a of NEW) {
  if (byValue.has(a.id)) { console.log(`  已存在，跳过  ${a.id}  ${a.name}`); continue; }
  console.log(`  ➕ ${a.id.padEnd(21)} ${a.plat.padEnd(9)} ${a.name}`);
  console.log(`       ${a.note}`);
  creates.push({
    [F.value]: a.id, [F.category]: CATEGORIES.account, [F.name]: a.name,
    [F.group]: GROUP, [F.platform]: a.plat, [F.enabled]: true,
  });
}

console.log("\n=== ② 修正归属：上架包(SmartReply) → 上架包(Savvy) ===");
for (const a of REGROUP) {
  const rec = byValue.get(a.id);
  if (!rec) { console.log(`  ⚠️ ${a.id} 不在配置表里 —— 本该是「新增」，请复核`); continue; }
  const cur = cellStr(rec.fields?.[F.group]).trim();
  const curName = cellStr(rec.fields?.[F.name]).trim();
  if (cur === GROUP) { console.log(`  已是目标值  ${a.id}  ${a.name}`); continue; }
  console.log(`  ✏️  ${a.id.padEnd(21)} 归属「${cur || "(空)"}」→「${GROUP}」`);
  console.log(`       名称「${curName}」→「${a.name}」（XMP 现名，旧名是建号时的）`);
  console.log(`       ${a.note}`);
  // 名称一并更正：这两个是上架包账户，不参与「按账户建飞书表」（那只对 PWA 账户），
  // 所以改名不会造成 feishu-tables.mjs 里警告的「表名对不上、历史表变孤儿」。
  updates.push({ record_id: rec.record_id, fields: { [F.group]: GROUP, [F.name]: a.name, [F.platform]: a.plat } });
}

console.log(`\n合计：新增 ${creates.length} 行 · 改归属 ${updates.length} 行`);
if (!APPLY) { console.log("\n[演练] 未写入。确认后加 --apply"); process.exit(0); }
if (creates.length) console.log(`✅ 新增 ${await batchCreate(tableId, creates)} 行`);
if (updates.length) console.log(`✅ 更新 ${await batchUpdate(tableId, updates)} 行`);
console.log("\n下一步：node sync-config-from-feishu.mjs && node fetch-snapshot.mjs 20");
