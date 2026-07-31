// 一次性：把 3 个新建的 TikTok PWA 账户加进飞书「XMP抓取配置」（幂等，已存在则只补缺失字段）。
// 已在 XMP 核对：渠道 tiktok、系列名全是 PWA-*、2026-07-31 起有花费。
// 用法：node add-tt-accounts.mjs [--dry]
import { tableIdMap, listRecords, batchCreate, batchUpdate, cellStr } from "./lib/feishu.mjs";
import { xmpConfigTable } from "./feishu-tables.mjs";

const DRY = process.argv.includes("--dry");
const F = xmpConfigTable.F;

const ACCOUNTS = [
  { id: "7639625690962640914", name: "省广_GC_pwa_1_zmf",      owner: "zmf" },
  { id: "7639625025477623815", name: "省广_GC_pwa_2_wcx",      owner: "wcx" },
  { id: "7639625716434485256", name: "省广_GC AND_6_ymt(pwa)", owner: "ymt" },
];
const COMMON = { [F.category]: "广告账户", [F.group]: "PWA", 广告平台: "TikTok", [F.enabled]: true };

const tableId = (await tableIdMap())[xmpConfigTable.name];
if (!tableId) throw new Error(`飞书里没有「${xmpConfigTable.name}」表`);
const records = await listRecords(tableId);
const byValue = new Map(records.map((r) => [cellStr(r.fields?.[F.value]).trim(), r]));

const creates = [], updates = [];
for (const a of ACCOUNTS) {
  const want = { [F.value]: a.id, [F.name]: a.name, 优化师: a.owner, ...COMMON };
  const exist = byValue.get(a.id);
  if (!exist) {
    creates.push(want);
    console.log(`新增 ${a.id}  ${a.name}  TikTok/PWA/${a.owner}`);
    continue;
  }
  // 已存在：只补差异字段，不覆盖用户手填的内容
  const fields = {};
  for (const [k, v] of Object.entries(want)) {
    if (k === F.enabled) continue;
    if (cellStr(exist.fields?.[k]).trim() !== String(v)) fields[k] = v;
  }
  if (Object.keys(fields).length) {
    updates.push({ record_id: exist.record_id, fields });
    console.log(`补字段 ${a.id}  ${Object.keys(fields).join("、")}`);
  } else {
    console.log(`已存在且正确 ${a.id}  ${a.name}`);
  }
}

if (DRY) { console.log("\n--dry：未写入"); process.exit(0); }
if (creates.length) console.log(`\n✅ 新增 ${await batchCreate(tableId, creates)} 行`);
if (updates.length) console.log(`✅ 更新 ${await batchUpdate(tableId, updates)} 行`);
if (!creates.length && !updates.length) console.log("\n无需改动");
