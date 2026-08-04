// 账户归属核对 —— 计划搭完后跑，按 XMP 系列名判断每个账户实际投的产品，
// 与飞书「广告账户归属」比对，列出需要改的行。同时回填缺失的账户名。
// 用法：node check-account-group.mjs              # 只报告
//       node check-account-group.mjs --fix-names  # 顺便补**空的**账户名（不覆写已有名称，见下方注释）
import { fetchReport } from "./lib/xmp.mjs";
import { tableIdMap, listRecords, batchUpdate, cellStr } from "./lib/feishu.mjs";
import { xmpConfigTable } from "./feishu-tables.mjs";
import { ACTIVE_PWA_ACCOUNT_IDS } from "./lib/pwa-accounts.mjs";

const FIX = process.argv.includes("--fix-names");
const F = xmpConfigTable.F;
// 与 feishu-tables.mjs 的 APP_GROUP_PATTERN 同源：系列/账户名含这些词 → 上架包
// 注意 SR 常以 `SR_android_...` 形式出现，`\bSR\b` 匹配不到（`_` 是 word 字符），需单列一条。
const APP_PAT = /上架包|smart\s*reply|smartreply|savvy|(^|[^A-Za-z])SR[_\-]|\bSR\b/i;
const PWA_PAT = /\bpwa\b/i;

const ymd = (d) => d.toISOString().slice(0, 10);
const to = new Date(), from = new Date(); from.setDate(from.getDate() - 14);
const rows = await fetchReport({
  startDate: ymd(from), endDate: ymd(to),
  dimension: ["date", "account_name", "campaign_id", "campaign_name"], metrics: ["cost"],
});

const acc = new Map();
for (const r of rows) {
  const id = String(r.account_id);
  const o = acc.get(id) || { name: "", module: "", cost: 0, camps: new Set() };
  o.cost += Number(r.cost) || 0;
  if (r.account_name) o.name = r.account_name;
  if (r.module) o.module = r.module;
  if (r.campaign_name) o.camps.add(r.campaign_name);
  acc.set(id, o);
}

const tableId = (await tableIdMap())[xmpConfigTable.name];
const recs = await listRecords(tableId);

const mismatch = [], noData = [], nameFix = [];
console.log("账户ID                 飞书归属  实测判定  渠道     14天花费   系列名样例");
for (const rec of recs) {
  const f = rec.fields || {};
  if (cellStr(f[F.category]).trim() !== "广告账户") continue;
  const id = cellStr(f[F.value]).trim();
  const group = cellStr(f[F.group]).trim() || "PWA";
  const x = acc.get(id);
  if (!x || x.cost === 0) { noData.push({ id, group }); continue; }

  const camps = [...x.camps];
  const blob = camps.join(" ") + " " + x.name;
  const verdict = APP_PAT.test(blob) ? "上架包" : PWA_PAT.test(blob) ? "PWA" : "未判定";
  // 归属列允许写细分值（如「上架包(Savvy)」）——与 feishu-tables 的 APP_GROUP_SQL 一致，
  // 只要匹配上架包模式就算同类，不能用字符串全等，否则细分归属会被误报成不一致。
  const groupCat = APP_PAT.test(group) ? "上架包" : "PWA";
  const bad = verdict !== "未判定" && verdict !== groupCat;
  if (bad) mismatch.push({ id, group, verdict, name: x.name, camps, record_id: rec.record_id });
  // ⚠️ 「名称」列是分账户飞书表的表名来源（feishu-tables.mjs → pwaAccountTable(a.name, a.id)）。
  //    覆写已有名称 = 重命名飞书表 → 同步找不到原表，历史数据变孤儿。所以只填空值，绝不覆写。
  //    （2026-08-03 踩过：回填 6 行导致 5 张分账户表同步失败，见 restore-account-names.mjs）
  if (x.name && !cellStr(f[F.name]).trim()) nameFix.push({ record_id: rec.record_id, fields: { [F.name]: x.name } });

  console.log(
    `${id.padEnd(21)} ${group.padEnd(8)} ${(bad ? "⚠️ " + verdict : verdict).padEnd(9)} ${String(x.module||"—").padEnd(8)} ${("$"+x.cost.toFixed(0)).padStart(9)}   ${camps.slice(0,2).join(" / ").slice(0,44)}`,
  );
}

if (noData.length) {
  console.log(`\n尚无花费（未开投/计划未搭完）${noData.length} 个：`);
  console.log("  " + noData.map((n) => `${n.id}(${n.group})`).join(", "));
}

if (mismatch.length) {
  console.log(`\n⚠️ 归属需要修正 ${mismatch.length} 个 —— 去飞书「XMP抓取配置」把「广告账户归属」改掉：`);
  for (const m of mismatch) {
    console.log(`   ${m.id}  ${m.name}`);
    console.log(`     飞书填「${m.group}」，但系列名显示是「${m.verdict}」：${m.camps.slice(0,3).join(" / ")}`);
  }
  const toPwaList = mismatch.filter((m) => m.verdict === "上架包" && ACTIVE_PWA_ACCOUNT_IDS.includes(m.id));
  if (toPwaList.length) {
    console.log(`\n   其中 ${toPwaList.length} 个还在 lib/pwa-accounts.mjs 的 ACTIVE_PWA_ACCOUNTS 里，需一并移除：`);
    toPwaList.forEach((m) => console.log(`     ${m.id}`));
  }
} else console.log("\n✅ 所有有花费的账户，归属与系列名一致。");

if (FIX && nameFix.length) {
  const n = await batchUpdate(tableId, nameFix);
  console.log(`\n✅ 回填账户名 ${n} 行`);
} else if (nameFix.length) {
  console.log(`\n有 ${nameFix.length} 个账户名可回填，加 --fix-names 执行`);
}
