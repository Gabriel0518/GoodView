// 取 af_events 里 SmartReply 的 customer_user_id 样本，供回查生产库 userinfo 的 app_name
import { query, end } from "./lib/db.mjs";

const { rows } = await query(`
  SELECT DISTINCT customer_user_id AS uid
    FROM af_events
   WHERE app_id = 'whisper.smart.reply' AND customer_user_id IS NOT NULL AND customer_user_id <> ''
   ORDER BY 1 LIMIT 25`);
console.log(rows.map((r) => r.uid).join(","));
const { rows: ev } = await query(`
  SELECT event_name, count(*) n, count(DISTINCT customer_user_id) uids
    FROM af_events WHERE app_id='whisper.smart.reply' GROUP BY event_name ORDER BY n DESC`);
console.log("\nSmartReply AF 事件:");
ev.forEach((r) => console.log(`  ${String(r.event_name).padEnd(38)} ${String(r.n).padStart(4)}条 ${String(r.uids).padStart(3)}人`));
await end();
