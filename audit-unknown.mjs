import fs from "node:fs";
const f = JSON.parse(fs.readFileSync("data/funnel.json", "utf8"));
const s = JSON.parse(fs.readFileSync("data/snapshot.json", "utf8"));
const SRC = f.meta.sources;
console.log("sources:", SRC.join("/"));
const g = (k) => f.stages.find((x) => x.key === k);
const sum = (st, src) => (st ? st.bySource[src]?.sum ?? 0 : 0);
const KEYS = ["lp_show", "install_success", "login_page", "ins_auth_click", "withdraw_first", "home_show"];
console.log("\n" + "阶段".padEnd(14) + SRC.map((x) => x.padEnd(9)).join("") + "合计");
for (const k of KEYS) {
  const st = g(k);
  if (st === undefined) { console.log(k, "缺"); continue; }
  const v = SRC.map((x) => sum(st, x));
  console.log(st.label.padEnd(12), v.map((x) => String(x).padEnd(9)).join(""), v.reduce((a, b) => a + b, 0));
}
const ig = g("ins_auth_click");
const igAll = SRC.reduce((a, x) => a + sum(ig, x), 0);
const igSnap = s.igAuthByDate.reduce((a, x) => a + x.count, 0);
console.log("\n=== 一致性校验 ===");
console.log("IG授权 5列合计:", igAll, "| snapshot全量:", igSnap, "| 差:", igAll - igSnap, igAll === igSnap ? "✓ 完全对齐" : "⚠️");
const known = ["AIguild", "fb", "tt", "bff"].reduce((a, x) => a + sum(ig, x), 0);
console.log("IG授权 unknown:", sum(ig, "unknown"), `(${((sum(ig, "unknown") / igAll) * 100).toFixed(0)}%) | 已知源合计:`, known);
let neg = 0, uz = 0;
for (const st of f.stages) {
  const u = st.bySource.unknown?.sum ?? 0;
  if (u === 0) uz++;
  for (const d of st.bySource.unknown?.data || []) if (d < 0) neg++;
}
console.log("unknown=0 的阶段:", uz, "/", f.stages.length, "| 负值天数(应为0):", neg);
const fail = f.stages.filter((st) => String(st.status).startsWith("失败"));
console.log("失败阶段数:", fail.length);
