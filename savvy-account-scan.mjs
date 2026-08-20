// Savvy 广告账户体检：XMP 近 N 天实际在投的 Savvy 账户 vs 「XMP抓取配置」白名单。
// 找出**新增但没配**的账户（这部分花费看板里看不到）。
// 用法：node savvy-account-scan.mjs [天数=14] [--refresh]
//
// ⚠️ XMP 的 token 能看到整个代理商的账户（167 个 / 近 14 天 $179 万），绝大多数是别的产品
//    （Romi/Luma/GraceChat/Dora…）。所以必须先把 Savvy 挑出来，不能拿「白名单外」当结论。
// ⚠️ XMP QPM=10，全量拉一次要 1~2 分钟 → 结果缓存到 tmp/，反复分析不重复打接口（--refresh 强制重拉）。
import fs from "node:fs/promises";
import { fetchReport } from "./lib/xmp.mjs";
import { query, end } from "./lib/db.mjs";

const DAYS = Number(process.argv.find((a) => /^\d+$/.test(a)) || 14);
const REFRESH = process.argv.includes("--refresh");
const CACHE = `tmp/xmp-${DAYS}d.json`;
const ymd = (d) => d.toISOString().slice(0, 10);
const to = new Date(), from = new Date();
from.setDate(from.getDate() - (DAYS - 1));
const D0 = ymd(from), D1 = ymd(to);

// Savvy 的判定：账户名或系列名里出现 savvy（现有账户全叫 省广_Savvyand_*）
const isSavvy = (s) => /savvy/i.test(String(s || ""));

async function load() {
  if (!REFRESH) {
    try {
      const c = JSON.parse(await fs.readFile(CACHE, "utf8"));
      if (c.D0 === D0 && c.D1 === D1) { console.log(`（用缓存 ${CACHE}，加 --refresh 强制重拉）`); return c.raw; }
    } catch { /* 没缓存就重拉 */ }
  }
  console.log(`拉 XMP ${D0} ~ ${D1} 全量（QPM=10，约 1~2 分钟）…`);
  const raw = await fetchReport({
    startDate: D0, endDate: D1,
    dimension: ["date", "account_name", "campaign_id", "campaign_name"],
    metrics: ["cost", "impression", "click"],
  });
  await fs.writeFile(CACHE, JSON.stringify({ D0, D1, raw }));
  return raw;
}

const raw = await load();

// 聚合到账户
const acc = new Map();
for (const r of raw) {
  const id = String(r.account_id);
  const o = acc.get(id) || { id, name: "", module: "", cost: 0, imp: 0, clk: 0, days: new Set(), camps: new Map() };
  const c = Number(r.cost) || 0;
  o.cost += c; o.imp += Number(r.impression) || 0; o.clk += Number(r.click) || 0;
  if (r.account_name) o.name = r.account_name;
  if (r.module) o.module = r.module;
  if (c > 0) {
    o.days.add(r.date);
    const cid = String(r.campaign_id || "");
    if (cid) {
      const cur = o.camps.get(cid) || { name: r.campaign_name || "", cost: 0 };
      cur.cost += c; if (r.campaign_name) cur.name = r.campaign_name;
      o.camps.set(cid, cur);
    }
  }
  acc.set(id, o);
}

// 只留 Savvy：账户名含 savvy，或**任何**在投系列名含 savvy（防止账户名没带产品名）
const savvy = [...acc.values()].filter((o) =>
  o.cost > 0 && (isSavvy(o.name) || [...o.camps.values()].some((c) => isSavvy(c.name))));

// 配置白名单（Postgres 镜像；权威源是飞书「XMP抓取配置」）
const { rows: cfg } = await query(
  `SELECT value, name, group_name, enabled FROM xmp_fetch_config WHERE category='account'`);
const cfgById = new Map(cfg.map((r) => [r.value, r]));

const sortedDays = (o) => [...o.days].sort();
const line = (o, tag) => {
  const d = sortedDays(o);
  console.log(`${tag} ${o.id.padEnd(21)} ${(o.module || "—").padEnd(9)} ${("$" + o.cost.toFixed(2)).padStart(11)}  ${d[0]}~${d[d.length - 1]}(${d.length}天)  ${o.name}`);
};

console.log(`\n=== XMP 近 ${DAYS} 天（${D0} ~ ${D1}）在投的 Savvy 账户：${savvy.length} 个 ===`);
savvy.sort((a, b) => b.cost - a.cost);

const missing = [], known = [];
for (const o of savvy) (cfgById.has(o.id) ? known : missing).push(o);

console.log(`\n【已在抓取配置里】${known.length} 个`);
for (const o of known) {
  const c = cfgById.get(o.id);
  line(o, c.enabled ? "  ✅" : "  ⏸ ");
  if (!c.enabled) console.log(`      ⚠️ 配置里是「停用」状态 → 花费没进库`);
  if (c.group_name && !/savvy/i.test(c.group_name)) console.log(`      ⚠️ 归属写的是「${c.group_name}」，不是 上架包(Savvy) → 花费会算进别的产品`);
}

console.log(`\n【不在抓取配置里 = 需要新增】${missing.length} 个`);
if (!missing.length) console.log("  （无，Savvy 账户已全覆盖）");
for (const o of missing) {
  line(o, "  ➕");
  [...o.camps.entries()].sort((a, b) => b[1].cost - a[1].cost).slice(0, 3)
    .forEach(([cid, c]) => console.log(`        └ ${cid.padEnd(20)} ${("$" + c.cost.toFixed(2)).padStart(10)}  ${c.name}`));
}

const missCost = missing.reduce((a, o) => a + o.cost, 0);
const totCost = savvy.reduce((a, o) => a + o.cost, 0);
console.log(`\nSavvy 近 ${DAYS} 天 XMP 花费合计 $${totCost.toFixed(2)}｜其中未覆盖 $${missCost.toFixed(2)}（${(missCost / totCost * 100).toFixed(1)}%）`);

// 配置里挂着 Savvy 归属、但近 N 天没花费的
const idle = cfg.filter((r) => /savvy/i.test(r.group_name || "") && !(acc.get(r.value)?.cost > 0));
if (idle.length) {
  console.log(`\n=== 配置里归属 Savvy、近 ${DAYS} 天无花费 ${idle.length} 个（停投了就留着，不用动）===`);
  idle.forEach((r) => console.log(`  ${r.value.padEnd(21)} ${r.enabled ? "启用" : "停用"}  ${r.name || "(无名)"}`));
}
await end();
