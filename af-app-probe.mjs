// 查 af_events 里 SmartReply 的 app_id / 包名（AF 是上架包唯一的转化来源）
import { query, end } from "./lib/db.mjs";

const { rows } = await query(`
  SELECT app_id, platform, count(*) AS n, count(DISTINCT customer_user_id) AS uids,
         min(event_time)::date AS d0, max(event_time)::date AS d1,
         string_agg(DISTINCT event_name, ', ') AS evs
    FROM af_events GROUP BY app_id, platform ORDER BY n DESC`);
console.log("af_events 按 app_id:");
for (const r of rows) {
  console.log(`  app_id=${String(r.app_id).padEnd(26)} ${String(r.platform).padEnd(9)} ${String(r.n).padStart(4)}条 ${String(r.uids).padStart(4)}个uid  ${r.d0?.toISOString?.().slice(0, 10)}~${r.d1?.toISOString?.().slice(0, 10)}`);
  console.log(`     事件: ${String(r.evs).slice(0, 120)}`);
}
await end();
