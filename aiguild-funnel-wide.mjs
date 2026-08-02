// AI公会完整漏斗（XMP 广告侧 + 线索 + BytePlus 站内），横向排列 + 逐步转化率
// 7/27~8/2，source ∈ AIguild/AIguild_active/AIguild_passive
import { query, end } from "./lib/db.mjs";

const FROM = "2026-07-27", TO = "2026-08-02";
const SRC = ["AIguild", "AIguild_active", "AIguild_passive"];
const LEADS = 534; // 用户给的线索量，替代「安装成功」

const { rows } = await query(
  `SELECT stage_key, SUM(count)::bigint AS n FROM funnel_daily
    WHERE date BETWEEN $1 AND $2 AND source = ANY($3::text[]) GROUP BY stage_key`, [FROM, TO, SRC]);
const f = Object.fromEntries(rows.map((r) => [r.stage_key, Number(r.n)]));

const { rows: sp } = await query(
  `SELECT SUM(impression)::bigint AS imp, SUM(click)::bigint AS clk, SUM(cost)::float8 AS cost
     FROM campaign_daily WHERE date BETWEEN $1 AND $2 AND account_id = ANY($3::text[])`,
  [FROM, TO, ["26222767373975427", "825268410518087"]]);
const { imp, clk, cost } = { imp: Number(sp[0].imp), clk: Number(sp[0].clk), cost: sp[0].cost };

// 主链路（按业务先后排；来源标出是 XMP 还是站内埋点）
const STEPS = [
  ["投广页曝光", imp, "XMP"],
  ["点击量", clk, "XMP"],
  ["线索", LEADS, "留咨表单"],
  ["谷歌登录页", f.login_page, "埋点"],
  ["名字页", f.set_name, "埋点"],
  ["年龄页", f.set_age, "埋点"],
  ["照片页", f.photo_page, "埋点"],
  ["电话页", f.phone_page, "埋点"],
  ["注册完成", f.cash_ready_show, "埋点"],
  ["Enter Paypal页", f.paypal_show, "埋点"],
  ["首笔提现完成", f.withdraw_first, "埋点"],
  ["可分发(GoLive)", f.live_go, "埋点"],
  ["IG授权成功", f.ins_auth_success, "埋点"],
  ["IG绑定完成", f.task_ins_bind, "埋点"],
  ["成材", f.chengcai, "埋点"],
];

const pct = (a, b) => (b > 0 ? (a / b * 100) : 0);
const leadIdx = STEPS.findIndex((s) => s[0] === "线索");

console.log(`AI公会完整漏斗 ${FROM} ~ ${TO}｜花费 $${cost.toFixed(2)}\n`);

// —— 横向排列：每行一个指标，列为各步骤 ——
const names = STEPS.map((s) => s[0]);
const vals = STEPS.map((s) => s[2] === "XMP" || s[0] === "线索" ? s[1] : (s[1] ?? 0));
const W = names.map((n, i) => Math.max(n.length * 2, String(vals[i]).length, 7));
const cell = (t, i) => String(t).padStart(W[i]);

const printBlock = (from, to) => {
  const idx = [];
  for (let i = from; i < to; i++) idx.push(i);
  console.log("步骤      " + idx.map((i) => cell(names[i], i)).join(" │ "));
  console.log("人数      " + idx.map((i) => cell(vals[i], i)).join(" │ "));
  console.log("环比上步  " + idx.map((i) => cell(i === 0 ? "—" : pct(vals[i], vals[i - 1]).toFixed(1) + "%", i)).join(" │ "));
  console.log("占线索    " + idx.map((i) => cell(i < leadIdx ? "—" : pct(vals[i], LEADS).toFixed(1) + "%", i)).join(" │ "));
  console.log("单价      " + idx.map((i) => cell(vals[i] > 0 ? "$" + (cost / vals[i]).toFixed(2) : "—", i)).join(" │ "));
  console.log("");
};
printBlock(0, 6);
printBlock(6, 11);
printBlock(11, 15);

console.log("=== 从线索起的逐步转化 ===");
console.log("步骤              人数    环比上一步    占线索");
for (let i = leadIdx; i < STEPS.length; i++) {
  const prev = i > leadIdx ? vals[i - 1] : null;
  console.log(
    `${names[i].padEnd(16)} ${String(vals[i]).padStart(6)}  ${(prev === null ? "—" : pct(vals[i], prev).toFixed(1) + "%").padStart(10)}  ${pct(vals[i], LEADS).toFixed(1).padStart(7)}%`,
  );
}
await end();
