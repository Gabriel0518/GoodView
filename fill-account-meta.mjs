// 扫描 XMP 抓取配置里的全部广告账户，补齐 名称 / 广告平台 / 归属
// ⚠️「名称」是分账户飞书表的表名来源 → 只补空值，绝不覆写（2026-08-03 踩过）
// 用法：node fill-account-meta.mjs [--apply]
import { fetchReport } from "./lib/xmp.mjs";
import { tableIdMap, listRecords, batchUpdate, cellStr } from "./lib/feishu.mjs";
import { xmpConfigTable } from "./feishu-tables.mjs";

const APPLY = process.argv.includes("--apply");
const F = { ...xmpConfigTable.F, platform: "广告平台" };
const APP_PAT = /上架包|smart\s*reply|smartreply|savvy|(^|[^A-Za-z])SR[_\-]|\bSR\b/i;
const SAVVY_PAT = /savvy/i;
const PWA_PAT = /\bpwa\b/i;

// 拉 90 天，尽量覆盖到低频/停投账户
const ymd = (d) => d.toISOString().slice(0, 10);
const to = new Date(), from = new Date(); from.setDate(from.getDate() - 90);
const raw = await fetchReport({
  startDate: ymd(from), endDate: ymd(to),
  dimension: ["date", "account_name", "campaign_id", "campaign_name"], metrics: ["cost"],
});
const seen = new Map();
for (const r of raw) {
  const id = String(r.account_id);
  const o = seen.get(id) || { name: "", module: "", cost: 0, camps: new Set(), last: "" };
  o.cost += Number(r.cost) || 0;
  if (r.account_name) o.name = r.account_name;
  if (r.module) o.module = r.module;
  if (r.campaign_name && Number(r.cost) > 0) { o.camps.add(r.campaign_name); if (r.date > o.last) o.last = r.date; }
  seen.set(id, o);
}
const PLATFORM = { tiktok: "TikTok", google: "Google", facebook: "Facebook" };

const tableId = (await tableIdMap())[xmpConfigTable.name];
const recs = await listRecords(tableId);
const updates = [], report = [], conflicts = [], noData = [];

for (const rec of recs) {
  const f = rec.fields || {};
  if (cellStr(f[F.category]).trim() !== "广告账户") continue;
  const id = cellStr(f[F.value]).trim();
  const curName = cellStr(f[F.name]).trim();
  const curGroup = cellStr(f[F.group]).trim();
  const curPlat = cellStr(f[F.platform]).trim();
  const x = seen.get(id);

  if (!x || (!x.name && !x.cost)) { noData.push({ id, curName, curGroup, curPlat }); continue; }

  const fields = {};
  if (!curName && x.name) fields[F.name] = x.name;            // 只补空值
  const plat = PLATFORM[x.module] || x.module || "";
  if (plat && curPlat !== plat) fields[F.platform] = plat;

  // 归属：按系列名+账户名判定
  const blob = [...x.camps].join(" ") + " " + x.name;
  const verdict = SAVVY_PAT.test(blob) ? "上架包(Savvy)"
    : APP_PAT.test(blob) ? "上架包" : PWA_PAT.test(blob) ? "PWA" : "";
  const curCat = APP_PAT.test(curGroup) ? "上架包" : curGroup ? "PWA" : "";
  const newCat = APP_PAT.test(verdict) ? "上架包" : verdict ? "PWA" : "";
  if (!curGroup && verdict) fields[F.group] = verdict;
  else if (verdict && curCat && newCat && curCat !== newCat) conflicts.push({ id, name: x.name, curGroup, verdict, camps: [...x.camps].slice(0, 3) });

  if (Object.keys(fields).length) updates.push({ record_id: rec.record_id, fields });
  report.push({ id, name: curName || x.name, group: fields[F.group] || curGroup || "PWA(默认)", plat: plat || curPlat || "—", cost: x.cost, last: x.last });
}

report.sort((a, b) => b.cost - a.cost);
console.log(`=== 有 XMP 数据的账户 ${report.length} 个（近 90 天）===`);
console.log("account_id            平台      归属            90天花费   最后有花费   账户名");
report.forEach((r) => console.log(
  `${r.id.padEnd(21)} ${r.plat.padEnd(9)} ${r.group.padEnd(15)} ${("$" + r.cost.toFixed(0)).padStart(9)}   ${(r.last || "—").padEnd(11)} ${r.name}`));

if (noData.length) {
  console.log(`\n=== XMP 近 90 天查无数据 ${noData.length} 个（未开投，名称/平台取不到）===`);
  noData.forEach((r) => console.log(`  ${r.id.padEnd(21)} 归属=${r.curGroup || "(空)"}  名称=${r.curName || "(空)"}`));
}
if (conflicts.length) {
  console.log(`\n⚠️ 归属与系列名冲突 ${conflicts.length} 个（未自动改，请人工确认）：`);
  conflicts.forEach((c) => console.log(`  ${c.id} ${c.name}\n     飞书=${c.curGroup} / 实测=${c.verdict}\n     系列：${c.camps.join(" / ")}`));
}

console.log(`\n待写入 ${updates.length} 行`);
if (!APPLY) { console.log("[演练] 加 --apply 执行"); process.exit(0); }
if (updates.length) console.log(`✅ 已更新 ${await batchUpdate(tableId, updates)} 行 → 下一步 node sync-config-from-feishu.mjs`);
