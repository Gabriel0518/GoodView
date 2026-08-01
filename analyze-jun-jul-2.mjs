// 第二轮：拆解单价上涨的两个来源——① 流量成本 ② 漏斗转化率；并看渠道/来源结构变化
import { query, end } from "./lib/db.mjs";

const FROM = "2026-06-01", TO = "2026-07-31";
const PWA = `(campaign_name ~* 'pwa|sitin' OR account_name ~* 'pwa|sitin')`;
const NON_GUILD = `source NOT IN ('AIguild','AIguild_active','AIguild_passive')`;

const weeks = [];
for (let d = new Date(FROM + "T00:00:00Z"); d <= new Date(TO + "T00:00:00Z");) {
  const a = new Date(d), b = new Date(d); b.setUTCDate(b.getUTCDate() + 6);
  weeks.push({ from: a.toISOString().slice(0, 10), to: (b > new Date(TO + "T00:00:00Z") ? new Date(TO + "T00:00:00Z") : b).toISOString().slice(0, 10) });
  d.setUTCDate(d.getUTCDate() + 7);
}
const inW = (d, w) => d >= w.from && d <= w.to;

const { rows: sp } = await query(
  `SELECT date::text AS d, channel, SUM(cost)::float8 AS c, SUM(impression)::bigint AS imp, SUM(click)::bigint AS clk
     FROM campaign_daily WHERE date BETWEEN $1 AND $2 AND cost > 0 AND ${PWA}
    GROUP BY date, channel`, [FROM, TO]);

const { rows: fn } = await query(
  `SELECT date::text AS d, stage_key, source, SUM(count)::bigint AS n FROM funnel_daily
    WHERE date BETWEEN $1 AND $2 AND ${NON_GUILD} GROUP BY date, stage_key, source`, [FROM, TO]);

const agg = (w) => {
  const s = { cost: 0, imp: 0, clk: 0, byCh: {} };
  for (const r of sp) if (inW(r.d, w)) {
    s.cost += r.c; s.imp += Number(r.imp); s.clk += Number(r.clk);
    s.byCh[r.channel] = (s.byCh[r.channel] || 0) + r.c;
  }
  const st = {}, bySrc = {};
  for (const r of fn) if (inW(r.d, w)) {
    st[r.stage_key] = (st[r.stage_key] || 0) + Number(r.n);
    if (r.stage_key === "cash_ready_show") bySrc[r.source] = (bySrc[r.source] || 0) + Number(r.n);
  }
  return { ...s, st, bySrc };
};

const f = (v, n = 2) => Number(v).toFixed(n);
const pctS = (a, b) => (b > 0 ? ((a / b) * 100).toFixed(1) + "%" : "—");

console.log("=== 四、流量成本（花费 ÷ 各前端环节）===");
console.log("周               花费     媒体曝光   CPM   媒体点击  CPC   投广页曝光 每次投广曝光成本  登录页  每次登录页成本");
for (const w of weeks) {
  const a = agg(w);
  console.log(`${w.from}~${w.to.slice(5)} ${f(a.cost).padStart(9)} ${String(a.imp).padStart(9)} ${f(a.imp ? a.cost / a.imp * 1000 : 0).padStart(6)} ${String(a.clk).padStart(8)} ${f(a.clk ? a.cost / a.clk : 0).padStart(5)} ${String(a.st.lp_show || 0).padStart(9)} ${f(a.st.lp_show ? a.cost / a.st.lp_show : 0).padStart(14)} ${String(a.st.login_page || 0).padStart(7)} ${f(a.st.login_page ? a.cost / a.st.login_page : 0).padStart(12)}`);
}

console.log("\n=== 五、渠道结构（花费占比）===");
console.log("周               facebook   tiktok   google");
for (const w of weeks) {
  const a = agg(w);
  const t = a.cost || 1;
  console.log(`${w.from}~${w.to.slice(5)} ${pctS(a.byCh.facebook || 0, t).padStart(9)} ${pctS(a.byCh.tiktok || 0, t).padStart(8)} ${pctS(a.byCh.google || 0, t).padStart(8)}`);
}

console.log("\n=== 六、注册来源结构（funnel source）===");
console.log("周                  fb      tt     bff  unknown   合计");
for (const w of weeks) {
  const a = agg(w);
  const t = Object.values(a.bySrc).reduce((x, y) => x + y, 0) || 1;
  console.log(`${w.from}~${w.to.slice(5)} ${pctS(a.bySrc.fb || 0, t).padStart(7)} ${pctS(a.bySrc.tt || 0, t).padStart(7)} ${pctS(a.bySrc.bff || 0, t).padStart(7)} ${pctS(a.bySrc.unknown || 0, t).padStart(7)} ${String(t).padStart(6)}`);
}

console.log("\n=== 七、注册前链路的分步转化（找最大漏点）===");
console.log("周              投广曝光→点击 点击→登录页 登录页→注册 | 投广曝光→注册(端到端)");
for (const w of weeks) {
  const a = agg(w), s = a.st;
  console.log(`${w.from}~${w.to.slice(5)} ${pctS(s.lp_click, s.lp_show).padStart(12)} ${pctS(s.login_page, s.lp_click).padStart(10)} ${pctS(s.cash_ready_show, s.login_page).padStart(10)} | ${pctS(s.cash_ready_show, s.lp_show).padStart(18)}`);
}

console.log("\n=== 八、IG 链路分步（授权浮层→点击→授权成功）===");
console.log("周              注册→浮层曝光 浮层曝光→点击 点击→授权成功");
for (const w of weeks) {
  const a = agg(w), s = a.st;
  console.log(`${w.from}~${w.to.slice(5)} ${pctS(s.ins_auth_show, s.cash_ready_show).padStart(12)} ${pctS(s.ins_auth_click, s.ins_auth_show).padStart(12)} ${pctS(s.ins_auth_success, s.ins_auth_click).padStart(12)}`);
}

await end();
