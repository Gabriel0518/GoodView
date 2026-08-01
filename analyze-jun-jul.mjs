// 6/1~7/31 PWA 投放 × 漏斗 周维度分析（找单价上涨的根因环节）
//
// 口径：
//   花费   = campaign_daily 里 系列名或账户名含 pwa/sitin 的行（AI公会系列名是 Customer Form/web_text、
//            上架包是 SR_/Smart Reply，都不匹配 → 天然排除）。6/1~6/14 库里还混着别产品账户，必须过滤。
//   漏斗   = funnel_daily 排除 AIguild 三个 source（PWA 非公会口径），按天求和
//   IG绑定 = 7/24 前 BytePlus 埋点没上报 task_id → 该阶段历史值恒为 0，本脚本单独从业务库补
import { query, end } from "./lib/db.mjs";
import { query as dmsQuery, dayExpr } from "./lib/dms.mjs";

const FROM = "2026-06-01", TO = "2026-07-31";
const PWA = `(campaign_name ~* 'pwa|sitin' OR account_name ~* 'pwa|sitin')`;
const NON_GUILD = `source NOT IN ('AIguild','AIguild_active','AIguild_passive')`;

// 7 天一桶
const weeks = [];
for (let d = new Date(FROM + "T00:00:00Z"); d <= new Date(TO + "T00:00:00Z");) {
  const a = new Date(d), b = new Date(d); b.setUTCDate(b.getUTCDate() + 6);
  weeks.push({ from: a.toISOString().slice(0, 10), to: (b > new Date(TO + "T00:00:00Z") ? new Date(TO + "T00:00:00Z") : b).toISOString().slice(0, 10) });
  d.setUTCDate(d.getUTCDate() + 7);
}

const STAGES = [
  ["lp_show", "投广页曝光"], ["lp_click", "投广页点击"],
  ["install_show", "安装页曝光"], ["install_success", "安装成功"],
  ["login_page", "谷歌登录页"], ["cash_ready_show", "注册完成"],
  ["home_show", "Home页曝光"], ["live_go", "可分发(GoLive)"],
  ["ins_auth_show", "Ins授权浮层曝光"], ["ins_auth_click", "Ins授权浮层点击"],
  ["ins_auth_success", "IG授权成功"], ["withdraw_first", "首提0.5"],
  ["chengcai", "成材"],
];

// 花费
const { rows: sp } = await query(
  `SELECT date::text AS d, SUM(cost)::float8 AS c FROM campaign_daily
    WHERE date BETWEEN $1 AND $2 AND cost > 0 AND ${PWA} GROUP BY date`, [FROM, TO]);
const spend = Object.fromEntries(sp.map((r) => [r.d, r.c]));

// 漏斗
const { rows: fn } = await query(
  `SELECT date::text AS d, stage_key, SUM(count)::bigint AS n FROM funnel_daily
    WHERE date BETWEEN $1 AND $2 AND ${NON_GUILD} GROUP BY date, stage_key`, [FROM, TO]);
const funnel = {};
for (const r of fn) (funnel[r.d] ||= {})[r.stage_key] = Number(r.n);

// IG绑定：业务库（埋点历史缺 task_id）
const igRows = await dmsQuery(
  `SELECT ${dayExpr("update_at", "America/Chicago")} AS d, count(*) AS n
     FROM user_common_task
    WHERE task_id='110' AND status='FINISHED'
      AND update_at >= '${FROM}' AND update_at < '${TO} 23:59:59'::timestamp + interval '1 day'
    GROUP BY 1`);
const igBind = Object.fromEntries(igRows.map((r) => [String(r.d).slice(0, 10), Number(r.n)]));

const sumRange = (obj, from, to, key) => {
  let s = 0;
  for (const [d, v] of Object.entries(obj)) {
    if (d >= from && d <= to) s += key ? (v[key] || 0) : (Number(v) || 0);
  }
  return s;
};

const rows = weeks.map((w) => {
  const cost = sumRange(spend, w.from, w.to);
  const g = (k) => sumRange(funnel, w.from, w.to, k);
  const ig = sumRange(igBind, w.from, w.to);
  return { ...w, cost, ig, ...Object.fromEntries(STAGES.map(([k]) => [k, g(k)])) };
});

const p = (v, n) => (n > 0 ? (v / n) : 0);
const f2 = (v) => v.toFixed(2);
const pctS = (a, b) => (b > 0 ? ((a / b) * 100).toFixed(1) + "%" : "—");

console.log("=== 一、投放与核心单价（周）===");
console.log("周              花费      注册   注册单价  IG授权  授权单价  IG绑定  绑定单价   成材  成材单价");
for (const r of rows) {
  console.log(
    `${r.from}~${r.to.slice(5)}  ${f2(r.cost).padStart(8)} ${String(r.cash_ready_show).padStart(6)} ${f2(p(r.cost, r.cash_ready_show)).padStart(8)} ${String(r.ins_auth_success).padStart(6)} ${f2(p(r.cost, r.ins_auth_success)).padStart(8)} ${String(r.ig).padStart(6)} ${f2(p(r.cost, r.ig)).padStart(8)} ${String(r.chengcai).padStart(5)} ${f2(p(r.cost, r.chengcai)).padStart(8)}`,
  );
}

console.log("\n=== 二、漏斗各步转化率（周）===");
console.log("周              曝光→点击 点击→安装页 安装页→安装成功 安装→注册 注册→可分发 注册→授权 授权→绑定 注册→成材");
for (const r of rows) {
  console.log(
    `${r.from}~${r.to.slice(5)}  ${pctS(r.lp_click, r.lp_show).padStart(8)} ${pctS(r.install_show, r.lp_click).padStart(10)} ${pctS(r.install_success, r.install_show).padStart(14)} ${pctS(r.cash_ready_show, r.install_success).padStart(9)} ${pctS(r.live_go, r.cash_ready_show).padStart(10)} ${pctS(r.ins_auth_success, r.cash_ready_show).padStart(9)} ${pctS(r.ig, r.ins_auth_success).padStart(9)} ${pctS(r.chengcai, r.cash_ready_show).padStart(9)}`,
  );
}

console.log("\n=== 三、绝对量（周）===");
console.log("周              投广曝光  投广点击 安装页  安装成功 登录页  注册  可分发 授权浮层 浮层点击 授权成功 IG绑定 首提  成材");
for (const r of rows) {
  console.log(
    `${r.from}~${r.to.slice(5)} ${String(r.lp_show).padStart(8)} ${String(r.lp_click).padStart(8)} ${String(r.install_show).padStart(7)} ${String(r.install_success).padStart(7)} ${String(r.login_page).padStart(7)} ${String(r.cash_ready_show).padStart(6)} ${String(r.live_go).padStart(6)} ${String(r.ins_auth_show).padStart(7)} ${String(r.ins_auth_click).padStart(7)} ${String(r.ins_auth_success).padStart(7)} ${String(r.ig).padStart(6)} ${String(r.withdraw_first).padStart(5)} ${String(r.chengcai).padStart(5)}`,
  );
}

await end();
