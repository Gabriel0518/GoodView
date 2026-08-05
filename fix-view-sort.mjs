// 给飞书 Base 里所有带日期的表挂上「日期 降序」视图排序（新→旧）。
//
// 为什么要做：增量窗口同步每轮「删本窗口 + 追加重灌」，飞书记录的物理顺序 = 历次追加的拼接，
// 必然乱序（老历史在最前，每轮窗口跟在后面）。视图排序是持久规则，之后新灌的行自动归位，
// 不需要每轮同步再管顺序。新建的表由 feishu-init-tables 自动挂；这个脚本用于给存量表补挂。
//
// ⚠️ 需要自建应用开通 base:view:write_only（否则 99991672）。
// 用法：node fix-view-sort.mjs [--apply]
import { listTables, listFields } from "./lib/feishu.mjs";
import { applyViewSort, sortRuleFor, ruleText } from "./lib/view-sort.mjs";

const APPLY = process.argv.includes("--apply");

const tables = await listTables();
console.log(`Base 内共 ${tables.length} 张表\n`);

const plan = [], skipped = [];
for (const t of tables) {
  const rule = sortRuleFor((await listFields(t.table_id)).map((f) => f.field_name));
  if (!rule) { skipped.push(t.name); continue; }
  plan.push({ ...t, rule });
}

console.log(`=== 待设置 ${plan.length} 张表 ===`);
plan.forEach((p) => console.log(`  ${p.name.padEnd(24)} ← ${ruleText(p.rule)}`));
if (skipped.length) console.log(`\n跳过 ${skipped.length} 张（无日期/排序列）：${skipped.join(" · ")}`);

if (!APPLY) { console.log("\n[演练] 加 --apply 执行"); process.exit(0); }

let ok = 0, fail = 0;
for (const p of plan) {
  const r = await applyViewSort(p.table_id, p.rule);
  ok += r.ok;
  if (r.errors.length) { fail += r.errors.length; console.warn(`  ⚠️ ${p.name}：${r.errors[0]}`); }
}
console.log(`\n已设置 ${ok} 个视图排序${fail ? `，失败 ${fail} 个` : ""}`);
if (fail) console.log("若报 99991672：去开放平台给自建应用开通 base:view:write_only 后重跑。");
