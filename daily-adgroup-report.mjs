// PWA 广告组日报 + 优化建议。每天 9:15(UTC+8) 跑一次：
//   取「前一天」活跃 PWA 账户(lib/pwa-accounts)的每个在跑广告组 → 昨日花费/CTR/CPC + 近3日窗口
//   → 规则化优化建议(放量/维持/砍预算/暂停/测试观察) + 每组「可加量素材」(据 ad_daily 素材级 CTR/CPC)
//   → 写 Postgres adgroup_daily_report(累积历史) → 全量刷新飞书表「PWA广告组日报与优化」(清空整表只留目标日)。
// 飞书表只呈现「目标日」单日 → 每个广告组只出现一次，避免跨日出现互相矛盾的建议；历史回溯查 Postgres。
//
// 注册无法归因到广告组/素材(BytePlus 只到 source 级)，故广告组与素材层都只看点击经济性(CTR/CPC)；
// 当日大盘单价(活跃账户 fb-CPA)作为上下文列放每行。活跃账户集见 lib/pwa-accounts.mjs。
// 用法：node daily-adgroup-report.mjs [YYYY-MM-DD]   不传=自动取「前一天(UTC+8)」，缺数则回退到库里最新完整日。
import { query, withTx, bulkInsert, end } from "./lib/db.mjs";
import {
  listTables, createTable, tableIdMap, batchCreate, batchDelete,
  listAllRecordIds, listFields, createField, FT, dateMs, dateNum,
} from "./lib/feishu.mjs";
import { FEISHU } from "./config.mjs";
import { ACTIVE_PWA_ACCOUNTS as ACCOUNTS, ACTIVE_PWA_ACCOUNT_IDS as ACCOUNT_IDS } from "./lib/pwa-accounts.mjs";

// 活跃 PWA 账户唯一事实源在 lib/pwa-accounts.mjs（加/减账户改那一处，报表+素材抓取都跟着变）。
const FEISHU_TABLE = "PWA广告组日报与优化";

// —— 优化规则阈值：分渠道（Facebook / TikTok 口径不同）——
// Facebook 已按实测校准；TikTok 现无真实花费数据，暂沿用 FB 值（独立可调），起量后按 TikTok 实测重设。
const CH_THRESH = {
  facebook: {
    ctrDead: 4.5, ctrScale: 9.8, cpcScale: 0.30, ctrPause: 6, cpcPause: 0.45,
    cutCost: 300, ctrCut: 8, adCtrGood: 8, adCpcMax: 0.40,
  },
  tiktok: { // ⚠️ 临时=FB 值，待 TikTok 起量后按实测校准（TikTok CTR/CPC 基准与 FB 不同）
    ctrDead: 4.5, ctrScale: 9.8, cpcScale: 0.30, ctrPause: 6, cpcPause: 0.45,
    cutCost: 300, ctrCut: 8, adCtrGood: 8, adCpcMax: 0.40,
  },
};
const chT = (channel) => CH_THRESH[channel] || CH_THRESH.facebook;
// 渠道 → 注册来源（funnel source）：facebook=fb / tiktok=tt。大盘 CPA 分渠道算。
const CH_SOURCE = { facebook: "fb", tiktok: "tt" };

// —— 跨渠道通用阈值 ——
const THRESH = {
  newCost: 120,     // 新广告组近3日花费<此 → 视为测试期，给缓冲
  minDayCost: 1,    // 昨日花费<此的广告组当噪声跳过（不进日报）
  minAdCost: 10,    // 素材近3日花费<此 → 信号不足，不判「可加量」
};

const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

// 规则引擎：入渠道 + 近3日 CTR%/CPC$/花费 + 是否新 → { action, priority, reason }。门槛按渠道取。
function decide(channel, { ctr3, cpc3, cost3, isNew }) {
  const T = chT(channel);
  const c = r2(ctr3), p = r2(cpc3), s = Math.round(cost3);
  if (ctr3 < T.ctrDead)
    return { action: "暂停", priority: 1, reason: `近3日CTR ${c}% 极低，点击经济性差、直接拖高注册单价，停` };
  if (isNew && cost3 < THRESH.newCost)
    return { action: "测试观察", priority: 4, reason: `新广告组测试期(近3日$${s})：满$50或2天，CTR<${T.ctrPause}%或CPC>$${T.cpcScale}即淘汰、达标转放量` };
  if (ctr3 >= T.ctrScale && cpc3 <= T.cpcScale)
    return { action: "放量", priority: 1, reason: `CTR ${c}%、CPC $${p}，效率佳 → 日预算+20%(≤20%/天防重进学习期)` };
  if (cpc3 > T.cpcPause || ctr3 < T.ctrPause)
    return { action: "暂停", priority: 2, reason: `CTR ${c}% / CPC $${p} 点击经济性差，暂停或换素材` };
  if (cost3 >= T.cutCost && ctr3 < T.ctrCut)
    return { action: "砍预算", priority: 2, reason: `近3日花$${s}但CTR仅${c}%，性价比低 → 日预算砍50%` };
  return { action: "维持", priority: 5, reason: `CTR ${c}%、CPC $${p}，中等，维持观察` };
}

// 目标日期：优先传参；否则「前一天(UTC+8)」；若库里没到该日则回退到库里最新完整日。
async function resolveTargetDate(argDate) {
  const maxRow = await query(
    `SELECT MAX(date)::text AS mx FROM campaign_daily WHERE account_id = ANY($1)`, [ACCOUNT_IDS]);
  const maxDate = maxRow.rows[0].mx; // YYYY-MM-DD
  // 前一天(上海) = 最后一个完整日。优化建议只基于跑完的完整日 → 目标日绝不为「今天/未来」。
  const todayU8 = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  const y = new Date(todayU8 + "T00:00:00Z"); y.setUTCDate(y.getUTCDate() - 1);
  const yesterday = y.toISOString().slice(0, 10);
  // 传参也受「≤昨天」约束：即使显式传今天，也夹到昨天，防止把进行中的当天写进优化表。
  if (argDate) return { target: argDate > yesterday ? yesterday : argDate, maxDate, clamped: argDate > yesterday };
  // 若昨天还没入库（拉取延迟），用库里最新完整日（也 ≤ 昨天）
  const target = maxDate && maxDate < yesterday ? maxDate : yesterday;
  return { target, maxDate };
}

async function computeRows(target) {
  // 昨日：每个在跑广告组（有花费），带渠道
  const day = (await query(`
    SELECT account_id, account_name, channel, campaign_id, campaign_name, adset_id, adset_name,
           SUM(cost)::float8 cost, SUM(impression)::bigint impression, SUM(click)::bigint click
    FROM campaign_daily
    WHERE account_id = ANY($1) AND date = $2 AND cost >= $3
    GROUP BY account_id, account_name, channel, campaign_id, campaign_name, adset_id, adset_name`,
    [ACCOUNT_IDS, target, THRESH.minDayCost])).rows;
  // 广告组 → 渠道（素材门槛/CPA 分渠道用；一个广告组只属一个渠道）
  const chByAdset = Object.fromEntries(day.map((d) => [d.campaign_id + "|" + d.adset_id, d.channel]));

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

  // 每个广告组内「可加量素材」：近3日窗口，素材(ad)级 CTR/CPC 达放量门槛且有花费信号 → 列出；无则「无」。
  const ads = (await query(`
    SELECT campaign_id, adset_id, ad_name,
           SUM(cost)::float8 c, SUM(impression)::bigint imp, SUM(click)::bigint clk
    FROM ad_daily
    WHERE account_id = ANY($1) AND date > $2::date - 3 AND date <= $2::date
    GROUP BY campaign_id, adset_id, ad_name`, [ACCOUNT_IDS, target])).rows;
  const adsByAdset = {};
  for (const a of ads) {
    const c = Number(a.c), imp = Number(a.imp), clk = Number(a.clk);
    if (c < THRESH.minAdCost) continue;                        // 花费太小、无信号
    const ctr = imp ? clk / imp * 100 : 0, cpc = clk ? c / clk : 0;
    const k = a.campaign_id + "|" + a.adset_id;
    const T = chT(chByAdset[k]);                                // 门槛按该广告组渠道取
    if (ctr >= T.adCtrGood && cpc <= T.adCpcMax) {             // CTR 为主、CPC 软上限 = 可加量
      (adsByAdset[k] ||= []).push({ name: a.ad_name || "?", ctr, cpc });  // 完整素材名，不截断
    }
  }
  const scalableFor = (k) => {
    const list = (adsByAdset[k] || []).sort((x, y) => y.ctr - x.ctr);
    return list.length ? list.map((a) => `${a.name}(CTR${r2(a.ctr)}%/CPC$${r2(a.cpc)})`).join(" · ") : "无";
  };

  // 当日大盘单价（分渠道）：facebook=fb花费÷fb注册、tiktok=tt花费÷tt注册。
  // ⚠️ BytePlus 注册数据比 XMP 花费滞后约 1 天 → 用「最近有注册数据的日」(≤target) 算 CPA。
  const funnelMax = (await query(`SELECT MAX(date)::text a FROM funnel_daily`)).rows[0].a;
  const cpaDate = funnelMax && funnelMax < target ? funnelMax : target;
  const cpaByChannel = {};
  for (const [channel, src] of Object.entries(CH_SOURCE)) {
    const cost = (await query(
      `SELECT COALESCE(SUM(cost),0)::float8 c FROM campaign_daily
       WHERE account_id = ANY($1) AND channel = $2 AND date = $3`,
      [ACCOUNT_IDS, channel, cpaDate])).rows[0].c;
    const reg = (await query(
      `SELECT COALESCE(SUM(count),0)::int n FROM funnel_daily
       WHERE stage_key='cash_ready_show' AND source=$1 AND date = $2`, [src, cpaDate])).rows[0].n;
    cpaByChannel[channel] = (cost > 0 && reg > 0) ? r2(cost / reg) : null;
  }

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
    const channel = d.channel || "facebook";
    const dec = decide(channel, { ctr3, cpc3, cost3, isNew });
    return {
      date: target, account_id: d.account_id, account_name: d.account_name, channel,
      campaign_id: d.campaign_id, campaign_name: d.campaign_name || "",
      adset_id: d.adset_id, adset_name: d.adset_name || "",
      cost: r2(cost), impression: imp, click: clk,
      ctr: r2(ctr), cpc: r2(cpc), cost3: r2(cost3), ctr3: r2(ctr3), cpc3: r2(cpc3),
      is_new: isNew, action: dec.action, priority: dec.priority, reason: dec.reason,
      acct_cpa: cpaByChannel[channel] ?? null, scalable_ads: scalableFor(k),
    };
  });
  // 排序：渠道 → 优先级升序 → 花费降序（同渠道聚在一起，要处理的排前面）
  rows.sort((a, b) => a.channel.localeCompare(b.channel) || a.priority - b.priority || b.cost - a.cost);
  return { rows, cpaByChannel, cpaDate };
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
      { name: "channel", type: "text" },
      { name: "campaign_id", type: "text" }, { name: "campaign_name", type: "text" },
      { name: "adset_id", type: "text" }, { name: "adset_name", type: "text" },
      { name: "cost", type: "numeric" }, { name: "impression", type: "bigint" }, { name: "click", type: "bigint" },
      { name: "ctr", type: "numeric" }, { name: "cpc", type: "numeric" },
      { name: "cost3", type: "numeric" }, { name: "ctr3", type: "numeric" }, { name: "cpc3", type: "numeric" },
      { name: "is_new", type: "boolean" }, { name: "action", type: "text" },
      { name: "priority", type: "int" }, { name: "reason", type: "text" }, { name: "acct_cpa", type: "numeric" },
      { name: "scalable_ads", type: "text" },
    ], rows);
  });
}

const FEISHU_FIELDS = [
  { field_name: "标识", type: FT.TEXT },
  { field_name: "日期", type: FT.DATE },
  { field_name: "date_num", type: FT.NUMBER },
  { field_name: "账户", type: FT.SINGLE_SELECT, property: { options: ACCOUNTS.map((a, i) => ({ name: a.name, color: i % 10 })) } },
  { field_name: "渠道", type: FT.SINGLE_SELECT, property: { options: [{ name: "facebook", color: 1 }, { name: "tiktok", color: 3 }] } },
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
  { field_name: "可加量素材", type: FT.TEXT },
  { field_name: "大盘CPA", type: FT.NUMBER },
];

function toFeishu(r) {
  return {
    标识: `${r.date}|${r.account_id}|${r.campaign_id}|${r.adset_id}`,
    日期: dateMs(r.date), date_num: dateNum(r.date),
    账户: r.account_name, 渠道: r.channel || "facebook", 系列: r.campaign_name, 广告组: r.adset_name,
    状态: r.is_new ? "新" : "在跑", 建议: r.action, 优先级: r.priority,
    昨日花费: r.cost, "昨日CTR%": r.ctr, 昨日CPC: r.cpc,
    近3日花费: r.cost3, "近3日CTR%": r.ctr3, 近3日CPC: r.cpc3,
    理由: r.reason, 可加量素材: r.scalable_ads || "无", 大盘CPA: r.acct_cpa ?? 0,
  };
}

async function ensureFeishuTable() {
  const existing = new Set((await listTables()).map((t) => t.name));
  if (!existing.has(FEISHU_TABLE)) {
    const id = await createTable(FEISHU_TABLE, FEISHU_FIELDS);
    console.log(`  ✅ 建飞书表「${FEISHU_TABLE}」table_id=${id}`);
    return id;
  }
  const tableId = (await tableIdMap())[FEISHU_TABLE];
  // 已存在的表：补齐缺失字段（如新增「可加量素材」列），旧数据不动。
  const have = new Set((await listFields(tableId)).map((f) => f.field_name));
  for (const f of FEISHU_FIELDS) {
    if (!have.has(f.field_name)) {
      await createField(tableId, { field_name: f.field_name, type: f.type, ...(f.property ? { property: f.property } : {}) });
      console.log(`  ➕ 补飞书字段：${f.field_name}`);
    }
  }
  return tableId;
}

async function writeFeishu(target, rows) {
  if (!FEISHU.appToken) { console.log("  ⏭ 未配置 FEISHU_APP_TOKEN，跳过飞书写入。"); return; }
  const tableId = await ensureFeishuTable();
  // 只呈现目标日：全量清空整表再写当日 → 每个广告组只出现一次，不会跨日给出互相矛盾的建议。
  // （历史留在 Postgres adgroup_daily_report，需要回溯查库即可。）
  const old = await listAllRecordIds(tableId);
  const del = await batchDelete(tableId, old);
  const created = await batchCreate(tableId, rows.map(toFeishu));
  console.log(`  ✅ 飞书「${FEISHU_TABLE}」：清 ${del} · 写 ${created}（仅当日 ${target}）`);
}

async function main() {
  const argDate = process.argv[2] && /^\d{4}-\d{2}-\d{2}$/.test(process.argv[2]) ? process.argv[2] : null;
  const { target, maxDate } = await resolveTargetDate(argDate);
  console.log(`[广告组日报] 目标日=${target}（库内最新=${maxDate}）· 账户 ${ACCOUNTS.map((a) => a.name).join(" / ")}`);
  if (!argDate && maxDate && maxDate < target) {
    console.warn(`  ⚠️ 前一天(${target}) 还没入库，改用最新完整日 ${maxDate}`);
  }
  const { rows, cpaByChannel, cpaDate } = await computeRows(target);
  if (!rows.length) { console.warn("  ⚠️ 目标日无在跑广告组（可能数据未到），退出。"); return; }
  const cpaNote = cpaDate === target ? "" : `（注册滞后，CPA 按 ${cpaDate} 结算日计）`;
  const cpaStr = Object.entries(cpaByChannel).map(([c, v]) => `${c}=${v == null ? "N/A" : "$" + v}`).join(" · ");
  console.log(`  大盘CPA(分渠道): ${cpaStr} ${cpaNote}`);
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
