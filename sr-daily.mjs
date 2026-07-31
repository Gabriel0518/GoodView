// SmartReply(whisper.smart.reply) 按天注册数 —— AF af_login_success 去重人数
import { query, end } from "./lib/db.mjs";

const { rows } = await query(`
  SELECT (event_time AT TIME ZONE 'UTC')::date AS d,
         count(DISTINCT customer_user_id) FILTER (WHERE event_name='af_login_success') AS reg,
         count(*) FILTER (WHERE event_name='install') AS installs,
         count(*) AS all_events
    FROM af_events WHERE app_id='whisper.smart.reply'
   GROUP BY 1 ORDER BY 1`);
console.log("SmartReply 按天（AF，UTC）:");
console.log("日期         注册(af_login_success去重)  install事件  全部事件");
for (const r of rows) {
  console.log(`  ${r.d.toISOString().slice(0, 10)}  ${String(r.reg).padStart(10)}  ${String(r.installs).padStart(12)} ${String(r.all_events).padStart(10)}`);
}
const { rows: t } = await query(`
  SELECT min(received_at) AS r0, max(received_at) AS r1, count(*) AS n
    FROM af_events WHERE app_id='whisper.smart.reply'`);
console.log(`\nAF 接收窗口: ${t[0].r0?.toISOString().slice(0, 16)} ~ ${t[0].r1?.toISOString().slice(0, 16)}（共 ${t[0].n} 条）`);
await end();
