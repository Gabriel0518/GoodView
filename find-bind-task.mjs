// 在业务库里找 instagram_reward_type / bind_task 的落库位置
import { query } from "./lib/dms.mjs";

console.log("=== 1. 列名候选（reward / bind / ig / ins / type）===");
const cols = await query(`
  SELECT table_name, column_name, data_type
    FROM information_schema.columns
   WHERE table_schema='public'
     AND (column_name ~* 'reward' OR column_name ~* 'bind'
          OR (column_name ~* '(^|_)(ig|ins)(_|$)' AND column_name ~* 'type|task|status'))
   ORDER BY table_name, column_name`);
cols.forEach((r) => console.log(`  ${r.table_name}.${r.column_name}  (${r.data_type})`));

console.log("\n=== 2. 任务相关表里的 JSON/JSONB 列（reward_type 可能塞在里面）===");
const js = await query(`
  SELECT table_name, column_name, data_type
    FROM information_schema.columns
   WHERE table_schema='public' AND data_type IN ('json','jsonb')
     AND (table_name ~* 'task|reward|ins|user_common|earning')
   ORDER BY table_name`);
if (!js.length) console.log("  (无)");
js.forEach((r) => console.log(`  ${r.table_name}.${r.column_name}  (${r.data_type})`));

console.log("\n=== 3. user_common_task 全部列 + 近期样本 ===");
const c2 = await query(`SELECT column_name, data_type FROM information_schema.columns
   WHERE table_name='user_common_task' ORDER BY ordinal_position`);
console.log("  列: " + c2.map((r) => `${r.column_name}(${r.data_type})`).join("  "));
const s = await query(`SELECT * FROM user_common_task
   WHERE task_id='110' AND status='FINISHED' ORDER BY update_at DESC LIMIT 3`);
s.forEach((r) => console.log("  " + JSON.stringify(r)));

console.log("\n=== 4. 是否存在值为 'bind_task' 的列（扫候选文本列）===");
const cand = await query(`
  SELECT table_name, column_name FROM information_schema.columns
   WHERE table_schema='public' AND data_type IN ('character varying','text')
     AND (table_name ~* 'task|reward|ins|earning' )
     AND column_name ~* 'type|kind|category|name|action|source'
   ORDER BY table_name LIMIT 40`);
for (const c of cand) {
  try {
    const hit = await query(
      `SELECT count(*) n FROM ${c.table_name} WHERE ${c.column_name} = 'bind_task'`);
    if (Number(hit[0].n) > 0) console.log(`  ✅ ${c.table_name}.${c.column_name} 命中 ${hit[0].n} 行`);
  } catch { /* 表大/权限问题跳过 */ }
}
console.log("  （无 ✅ 行即所有候选列都没有 bind_task 值）");
