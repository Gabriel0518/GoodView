import fs from "node:fs";
const f = JSON.parse(fs.readFileSync("data/funnel.json", "utf8"));
const s = JSON.parse(fs.readFileSync("data/snapshot.json", "utf8"));
const get = (k) => f.stages.find((x) => x.key === k);
const SRC = ["AIguild", "fb", "tt", "bff"];
const sum = (st, src) => (st ? st.bySource[src]?.sum ?? 0 : 0);
const KEYS = ["lp_show", "install_success", "login_page", "login_click", "set_name", "phone_confirm", "withdraw_first", "cash_success", "mock_result", "ins_auth_show", "ins_auth_click", "task_ins_bind"];
for (const k of KEYS) {
  const st = get(k);
  if (st === undefined) { console.log(k, "缺"); continue; }
  const vals = SRC.map((x) => sum(st, x));
  console.log(st.label.padEnd(16), SRC.map((x, i) => `${x}=${vals[i]}`).join("  "), " 4源合计=" + vals.reduce((a, b) => a + b, 0));
}
const ai = (k) => sum(get(k), "AIguild");
const fb = (k) => sum(get(k), "fb");
console.log("\n=== AIguild 关键比值 ===");
console.log("登录页曝光:", ai("login_page"), "| 点击谷歌登录:", ai("login_click"), "| 名字页(登录后):", ai("set_name"));
console.log("点击谷歌登录→IG授权 =", ((ai("ins_auth_click") / ai("login_click")) * 100).toFixed(1) + "%  <- 当前卡片分母");
console.log("名字页(已登录)→IG授权 =", ((ai("ins_auth_click") / ai("set_name")) * 100).toFixed(1) + "%");
console.log("IG授权:", ai("ins_auth_click"), "| 首笔提现(0.5刀):", ai("withdraw_first"), "-> IG授权→首笔提现 =", ((ai("withdraw_first") / ai("ins_auth_click")) * 100).toFixed(1) + "%");
console.log("\n=== fb 对照(登录点击率) ===");
console.log("fb: 登录页", fb("login_page"), "-> 点击", fb("login_click"), `(${((fb("login_click") / fb("login_page")) * 100).toFixed(0)}%)`, " | AIguild:", ai("login_page"), "->", ai("login_click"), `(${((ai("login_click") / ai("login_page")) * 100).toFixed(1)}%)`);
const igGrouped = SRC.reduce((a, x) => a + sum(get("ins_auth_click"), x), 0);
const igTotal = s.igAuthByDate.reduce((a, x) => a + x.count, 0);
console.log("\n=== 无 source 缺口 ===");
console.log("IG授权 4源合计:", igGrouped, "| 全量:", igTotal, "| 无source用户:", igTotal - igGrouped, `(${(((igTotal - igGrouped) / igTotal) * 100).toFixed(0)}%)`);
