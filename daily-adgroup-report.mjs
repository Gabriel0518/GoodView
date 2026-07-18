// PWA 广告组日报 + 优化建议。每天 9:00(UTC+8) 跑一次：
//   取「前一天」两个可用账户(新_1_zmf / 新_4-ymt)的每个在跑广告组 → 昨日花费/CTR/CPC + 近3日窗口
//   → 规则化优化建议(放量/维持/砍预算/暂停/测试观察) → 写 Postgres adgroup_daily_report(累积)
//   → 追加到飞书表「PWA广告组日报与优化」(按日期幂等：先删当日行再插，保留历史与人工批注)。
//
// 注册无法归因到广告组(BytePlus 只到 source 级)，故广告组级只看点击经济性(CTR/CPC)；
// 当日大盘单价(两账户 fb-CPA)作为上下文列放每行。3_ymt 被封后账户集见 ACCOUNTS。
// 用法：node daily-adgroup-report.mjs [YYYY-MM-DD]   不传=自动取「前一天(UTC+8)」，缺数则回退到库里最新完整日。
import { query, withTx, bulkInsert, end } from "./lib/db.mjs";
import {
  listTables, createTable, tableIdMap, batchCreate, batchDelete,
  searchRecordIdsByDateNum, FT, dateMs, dateNum,
} from "./lib/feishu.mjs";
import { FEISHU } from "./config.mjs";

// —— 当前可用的 PWA facebook 账户（3_ymt 于 2026-07 被封，剩这两个）——
const ACCOUNTS = [
  { id: "2236726820405499", name: "省广_pwa_新_1_zmf" },
  { id: "937843245746108",  name: "省广_pwa_新_4-ymt" },
];
const ACCOUNT_IDS = ACCOUNTS.map((a) => a.id);
const FEISHU_TABLE = "PWA广告组日报与优化";

// —— 优化规则阈值（都可调；建议基于「近3日」窗口，比单日稳）——
const THRESH = {
  ctrDead: 4.5,     // 近3日 CTR 低于此 → 直接暂停（哪怕新）
  ctrScale: 9.8,    // 放量门槛：CTR≥此
  cpcScale: 0.30,   // 放量门槛：CPC≤此
  ctrPause: 6,      // CTR 低于此 → 暂停
  cpcPause: 0.45,   // CPC 高于此 → 暂停
  cutCost: 300,     // 近3日花费≥此 且 CTR<ctrCut → 砍预算
  ctrCut: 8,
  newCost: 120,     // 新广告组近3日花费<此 → 视为测试期，给缓冲
  minDayCost: 1,    // 昨日花费<此的广告组当噪声跳过（不进日报）
};

const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

// 规则引擎：入近3日 CTR%/CPC$/花费 + 是否新 → { action, priority, reason }
function decide({ ctr3, cpc3, cost3, isNew }) {
  const c = r2(ctr3), p = r2(cpc3), s = Math.round(cost3);
  if (ctr3 < THRESH.ctrDead)
    return { action: "暂停", priority: 1, reason: `近3日CTR ${c}% 极低，点击经济性差、直接拖高注册单价，停` };
  if (isNew && cost3 < THRESH.newCost)
    return { action: "测试观察", priority: 4, reason: `新广告组测试期(近3日$${s})：满$50或2天，CTR<8%或CPC>$0.30即淘汰、达标转放量` };
  if (ctr3 >= THRESH.ctrScale && cpc3 <= THRESH.cpcScale)
    return { action: "放量", priority: 1, reason: `CTR ${c}%、CPC $${p}，效率佳 → 日预算+20%(≤20%/天防重进学习期)` };
  if (cpc3 > THRESH.cpcPause || ctr3 < THRESH.ctrPause)
    return { action: "暂停", priority: 2, reason: `CTR ${c}% / CPC $${p} 点击经济性差，暂停或换素材` };
  if (cost3 >= THRESH.cutCost && ctr3 < THRESH.ctrCut)
    return { action: "砍预算", priority: 2, reason: `近3日花$${s}但CTR仅${c}%，性价比低 → 日预算砍50%` };
  return { action: "维持", priority: 5, reason: `CTR ${c}%、CPC $${p}，中等，维持观察` };
}

// 目标日期：优先传参；否则「前一天(UTC+8)」；若库里没到该日则回退到库里最新完整日。
async function resolveTargetDate(argDate) {
  const maxRow = await query(
    `SELECT MAX(date)::text AS mx FROM campaign_daily WHERE account_id = ANY($1)`, [ACCOUNT_IDS]);
  const maxDate = maxRow.rows[0].mx; // YYYY-MM-DD
  if (argDate) return { target: argDate, maxDate };
  // 前一天(UTC+8) = now+8h 再退一天，取日期部分
  const nowU8 = new Date(Date.now() + 8 * 3600 * 1000);
  const y = new Date(nowU8); y.setUTCDate(y.getUTCDate() - 1);
  const yesterday = y.toISOString().slice(0, 10);
  // 若昨天还没入库（拉取延迟），用库里最新日
  const target = maxDate && maxDate < yesterday ? maxDate : yesterday;
  return { target, maxDate };
}

async function computeRows(target) {
  // 昨日：每个在跑广告组（有花费）
  const day = (await query(`
    SELECT account_id, account_name, campaign_id, campaign_name, adset_id, adset_name,
           SUM(cost)::float8 cost, SUM(impression)::bigint impression, SUM(click)::bigint click
    FROM campaign_daily
    WHERE account_id = ANY($1) AND date = $2 AND cost >= $3
    GROUP BY account_id, account_name, campaign_id, campaign_name, adset_id, adset_name`,
    [ACCOUNT_IDS, target, THRESH.minDayCost])).rows;

  // 近3日窗口（含目标日）：作建议依据
  const w3 = (await query(`
    SELECT campaign_id, adset_id,
           SUM(cost)::float8 cost3, SUM(impression)::bigint imp3, SUM(click)::bigint clk3
    FROM campaign_daily
    WHERE account_id = ANY($1) AND date > $2::date - 3 AND date <= $2::date
    GROUP BY campaign_id, adset_id`, [ACCOUNT_IDS, target])).rows;
  const w3map = Object.fromEntries(w3.map((r) => [r.campaign_id + "|" + r.adset_id, r]));

  // 首见日期（判断是否新广告组）
  const fs = (await query(`
    SELECT campaign_id, adset_id, MIN(date)::text first_seen
    FROM campaign_daily WHERE account_id = ANY($1)
    GROUP BY campaign_id, adset_id`, [ACCOUNT_IDS])).rows;
  const fsmap = Object.fromEntries(fs.map((r) => [r.campaign_id + "|" + r.adset_id, r.first_seen]));

  // 当日大盘单价：两账户花费 ÷ fb 注册(cash_ready_show, source=fb)
  const acctCost = (await query(
    `SELECT COALESCE(SUM(cost),0)::float8 c FROM campaign_daily WHERE account_id = ANY($1) AND date = $2`,
    [ACCOUNT_IDS, target])).rows[0].c;
  const fbReg = (await query(
    `SELECT COALESCE(SUM(count),0)::int n FROM funnel_daily
     WHERE stage_key='cash_ready_show' AND source='fb' AND date = $1`, [target])).rows[0].n;
  const acctCpa = fbReg > 0 ? r2(acctCost / fbReg) : null;

  const rows = day.map((d) => {
    const k = d.campaign_id + "|" + d.adset_id;
    const w = w3map[k] || {};
    // node-pg 把 bigint/numeric 列返回为字符串 → 必须 Number() 后再算，否则 "0" 为真值会触发 除0=Infinity。
    const cost = Number(d.cost), imp = Number(d.impression), clk = Number(d.click);
    const cost3 = Number(w.cost3 || 0), imp3 = Number(w.imp3 || 0), clk3 = Number(w.clk3 || 0);
    const ctr = imp ? clk / imp * 100 : 0;
    const cpc = clk ? cost / clk : 0;
    const ctr3 = imp3 ? clk3 / imp3 * 100 : 0;
    const cpc3 = clk3 ? cost3 / clk3 : 0;
    const isNew = (fsmap[k] || "0000") >= subDays(target, 2); // 首见在近3天内
    const dec = decide({ ctr3, cpc3, cost3, isNew });
    return {
      date: target, account_id: d.account_id, account_name: d.account_name,
      campaign_id: d.campaign_id, campaign_name: d.campaign_name || "",
      adset_id: d.adset_id, adset_name: d.adset_name || "",
      cost: r2(cost), impression: imp, click: clk,
      ctr: r2(ctr), cpc: r2(cpc), cost3: r2(cost3), ctr3: r2(ctr3), cpc3: r2(cpc3),
      is_new: isNew, action: dec.action, priority: dec.priority, reason: dec.reason,
      acct_cpa: acctCpa,
    };
  });
  // 排序：优先级升序 → 花费降序（要处理的排前面）
  rows.sort((a, b) => a.priority - b.priority || b.cost - a.cost);
  return { rows, acctCost: r2(acctCost), fbReg, acctCpa };
}

function subDays(ymd, n) {
  const d = new Date(ymd + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

async function writePg(target, rows) {
  await withTx(async (client) => {
    await client.query(`DELETE FROM adgroup_daily_report WHERE date = $1`, [target]);
    await bulkInsert(client, "adgroup_daily_report", [
      { name: "date", type: "date" }, { name: "account_id", type: "text" }, { name: "account_name", type: "text" },
      { name: "campaign_id", type: "text" }, { name: "campaign_name", type: "text" },
      { name: "adset_id", type: "text" }, { name: "adset_name", type: "text" },
      { name: "cost", type: "numeric" }, { name: "impression", type: "bigint" }, { name: "click", type: "bigint" },
      { name: "ctr", type: "numeric" }, { name: "cpc", type: "numeric" },
      { name: "cost3", type: "numeric" }, { name: "ctr3", type: "numeric" }, { name: "cpc3", type: "numeric" },
      { name: "is_new", type: "boolean" }, { name: "action", type: "text" },
      { name: "priority", type: "int" }, { name: "reason", type: "text" }, { name: "acct_cpa", type: "numeric" },
    ], rows);
  });
}

const FEISHU_FIELDS = [
  { field_name: "标识", type: FT.TEXT },
  { field_name: "日期", type: FT.DATE },
  { field_name: "date_num", type: FT.NUMBER },
  { field_name: "账户", type: FT.SINGLE_SELECT, property: { options: ACCOUNTS.map((a, i) => ({ name: a.name, color: i })) } },
  { field_name: "系列", type: FT.TEXT },
  { field_name: "广告组", type: FT.TEXT },
  { field_name: "状态", type: FT.SINGLE_SELECT, property: { options: [{ name: "新", color: 1 }, { name: "在跑", color: 0 }] } },
  { field_name: "建议", type: FT.SINGLE_SELECT, property: { options: [
    { name: "放量", color: 2 }, { name: "维持", color: 0 }, { name: "砍预算", color: 4 },
    { name: "暂停", color: 7 }, { name: "测试观察", color: 1 }] } },
  { field_name: "优先级", type: FT.NUMBER },
  { field_name: "昨日花费", type: FT.NUMBER },
  { field_name: "昨日CTR%", type: FT.NUMBER },
  { field_name: "昨日CPC", type: FT.NUMBER },
  { field_name: "近3日花费", type: FT.NUMBER },
  { field_name: "近3日CTR%", type: FT.NUMBER },
  { field_name: "近3日CPC", type: FT.NUMBER },
  { field_name: "理由", type: FT.TEXT },
  { field_name: "大盘CPA", type: FT.NUMBER },
];

function toFeishu(r) {
  return {
    标识: `${r.date}|${r.account_id}|${r.campaign_id}|${r.adset_id}`,
    日期: dateMs(r.date), date_num: dateNum(r.date),
    账户: r.account_name, 系列: r.campaign_name, 广告组: r.adset_name,
    状态: r.is_new ? "新" : "在跑", 建议: r.action, 优先级: r.priority,
    昨日花费: r.cost, "昨日CTR%": r.ctr, 昨日CPC: r.cpc,
    近3日花费: r.cost3, "近3日CTR%": r.ctr3, 近3日CPC: r.cpc3,
    理由: r.reason, 大盘CPA: r.acct_cpa ?? 0,
  };
}

async function ensureFeishuTable() {
  const existing = new Set((await listTables()).map((t) => t.name));
  if (!existing.has(FEISHU_TABLE)) {
    const id = await createTable(FEISHU_TABLE, FEISHU_FIELDS);
    console.log(`  ✅ 建飞书表「${FEISHU_TABLE}」table_id=${id}`);
    return id;
  }
  return (await tableIdMap())[FEISHU_TABLE];
}

async function writeFeishu(target, rows) {
  if (!FEISHU.appToken) { console.log("  ⏭ 未配置 FEISHU_APP_TOKEN，跳过飞书写入。"); return; }
  const tableId = await ensureFeishuTable();
  const n = dateNum(target);
  const old = await searchRecordIdsByDateNum(tableId, "date_num", n, n); // 只删当日行，保留历史与人工批注
  const del = await batchDelete(tableId, old);
  const created = await batchCreate(tableId, rows.map(toFeishu));
  console.log(`  ✅ 飞书「${FEISHU_TABLE}」：删当日 ${del} · 写 ${created}`);
}

async function main() {
  const argDate = process.argv[2] && /^\d{4}-\d{2}-\d{2}$/.test(process.argv[2]) ? process.argv[2] : null;
  const { target, maxDate } = await resolveTargetDate(argDate);
  console.log(`[广告组日报] 目标日=${target}（库内最新=${maxDate}）· 账户 ${ACCOUNTS.map((a) => a.name).join(" / ")}`);
  if (!argDate && maxDate && maxDate < target) {
    console.warn(`  ⚠️ 前一天(${target}) 还没入库，改用最新完整日 ${maxDate}`);
  }
  const { rows, acctCost, fbReg, acctCpa } = await computeRows(target);
  if (!rows.length) { console.warn("  ⚠️ 目标日无在跑广告组（可能数据未到），退出。"); return; }
  console.log(`  两账户当日花费=$${acctCost} · fb注册=${fbReg} · 大盘CPA=${acctCpa == null ? "N/A" : "$" + acctCpa}`);
  await writePg(target, rows);
  console.log(`  ✅ Postgres adgroup_daily_report：写 ${rows.length} 行`);
  await writeFeishu(target, rows);
  // 控制台速览
  const tally = rows.reduce((m, r) => ((m[r.action] = (m[r.action] || 0) + 1), m), {});
  console.log("  建议分布：" + Object.entries(tally).map(([k, v]) => `${k}${v}`).join(" · "));
}

main()
  .catch((e) => { console.error("广告组日报失败：", e.message); process.exitCode = 1; })
  .finally(() => end().catch(() => {}));
