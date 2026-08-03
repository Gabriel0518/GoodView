// 验证 gender 哪个值是女端 + 收入表选型
import { query } from "./lib/dms.mjs";

console.log("=== gender 与「女端特征」的关系（PWA app_name=3）===");
console.log("女端 = 做任务赚钱的一侧：应有 face_score / IG绑定 / 提现");
const g = await query(`
  SELECT u.gender,
         count(*) n,
         count(*) FILTER (WHERE u.face_score IS NOT NULL) has_face,
         count(*) FILTER (WHERE u.is_face_verified) verified,
         count(DISTINCT t.user_id) ig_bound,
         count(DISTINCT w.user_id) withdrew
    FROM userinfo u
    LEFT JOIN user_common_task t ON t.user_id=u.user_id AND t.task_id='110' AND t.status='FINISHED'
    LEFT JOIN user_withdraw_task w ON w.user_id=u.user_id
   WHERE u.app_name='3' GROUP BY 1 ORDER BY n DESC`);
console.log("gender  用户数   有face_score  已验证   IG绑定   提现过");
for (const r of g)
  console.log(`  ${String(r.gender).padEnd(6)}${String(r.n).padStart(7)}${String(r.has_face).padStart(13)}${String(r.verified).padStart(9)}${String(r.ig_bound).padStart(9)}${String(r.withdrew).padStart(9)}`);

for (const tbl of ["pwa_user_balance_change_history", "user_text_earning", "pwa_relation_revenue", "user_balance"]) {
  console.log(`\n=== ${tbl} ===`);
  try {
    const c = await query(`SELECT column_name,data_type FROM information_schema.columns
       WHERE table_name='${tbl}' ORDER BY ordinal_position`);
    console.log("  列: " + c.map((r) => `${r.column_name}(${r.data_type})`).join(" "));
    const n = await query(`SELECT count(*) n, min(create_at)::text d0, max(create_at)::text d1 FROM ${tbl}`)
      .catch(() => query(`SELECT count(*) n FROM ${tbl}`));
    console.log(`  行数 ${n[0].n}${n[0].d0 ? `  时间 ${n[0].d0} ~ ${n[0].d1}` : ""}`);
  } catch (e) { console.log("  失败: " + e.message.slice(0, 100)); }
}
