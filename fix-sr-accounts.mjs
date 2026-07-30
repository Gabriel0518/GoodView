// 一次性：修正飞书「XMP抓取配置」里上架包(SmartReply)账户的名称/归属，并补齐缺失账户。
// 已在 XMP 逐个核对：这 4 个账户近 14 天的系列全是 SR_*/Smart Reply_*，是上架包产品，不是 PWA。
// 用法：node fix-sr-accounts.mjs [--dry]
import { tableIdMap, listRecords, batchUpdate, batchCreate, cellStr } from "./lib/feishu.mjs";
import { xmpConfigTable } from "./feishu-tables.mjs";

const DRY = process.argv.includes("--dry");
const F = xmpConfigTable.F;
const GROUP = "上架包";

// id → { name, channel }（名称取 XMP 报表里的账户名）
const SR = {
  "6245583421":          { name: "AI Fantasy-T8088",     channel: "Google" },
  "7665547836257058834": { name: "省广_SR_and_1-5D80",   channel: "TikTok" },
  "27589868840681799":   { name: "省广_SR_and_5_wcx",    channel: "Facebook" },
  "1013644987935186":    { name: "QQ-TZCH-3A-0721+8-01", channel: "Facebook" },
};

const tableId = (await tableIdMap())[xmpConfigTable.name];
if (!tableId) throw new Error(`飞书里没有「${xmpConfigTable.name}」表`);
const records = await listRecords(tableId);

const updates = [];
const found = new Set();
for (const rec of records) {
  const f = rec.fields || {};
  const value = cellStr(f[F.value]).trim();
  if (!SR[value]) continue;
  found.add(value);
  const want = SR[value];
  const cur = { name: cellStr(f[F.name]).trim(), group: cellStr(f[F.group]).trim(), ch: cellStr(f["广告平台"]).trim() };
  const fields = {};
  if (cur.name !== want.name) fields[F.name] = want.name;
  if (cur.group !== GROUP) fields[F.group] = GROUP;
  if (!cur.ch) fields["广告平台"] = want.channel;
  if (Object.keys(fields).length) {
    updates.push({ record_id: rec.record_id, fields });
    console.log(`改 ${value}  「${cur.name}」/${cur.group || "(空)"} → 「${want.name}」/${GROUP}`);
  } else {
    console.log(`已正确 ${value}  ${want.name}/${GROUP}`);
  }
}

const creates = Object.entries(SR).filter(([id]) => !found.has(id)).map(([id, w]) => ({
  fields: { [F.value]: id, [F.category]: "广告账户", [F.name]: w.name, [F.group]: GROUP, 广告平台: w.channel, [F.enabled]: true },
}));
creates.forEach((c) => console.log(`新增 ${c.fields[F.value]}  ${c.fields[F.name]}/${GROUP}`));

if (DRY) { console.log("\n--dry：未写入"); process.exit(0); }
if (updates.length) console.log(`\n✅ 更新 ${await batchUpdate(tableId, updates)} 行`);
if (creates.length) console.log(`✅ 新增 ${await batchCreate(tableId, creates.map((c) => c.fields))} 行`);
if (!updates.length && !creates.length) console.log("\n无需改动");
