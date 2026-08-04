// 回答四个口径问题：mock 影响 / 0秒通话 / 免费vs付费视频 / 复访基数
import { query } from "./lib/dms.mjs";
const TZ = "America/Chicago";
const ch = (c) => `((${c} AT TIME ZONE 'UTC') AT TIME ZONE '${TZ}')`;
const M0 = "2026-07-01", M1 = "2026-08-01";

console.log("=== 1) order_type × amount 是否为 0 —— 免费/付费怎么分 ===");
const a = await query(`
  SELECT order_type, status,
         CASE WHEN NULLIF(amount,'')::numeric > 0 THEN '付费(amount>0)' ELSE '免费(amount=0)' END kind,
         count(*) n,
         round(avg(call_duration)::numeric,1) 均时长秒,
         round(avg(NULLIF(free_call_duration,0))::numeric,1) 均免费额度秒,
         count(*) FILTER (WHERE call_duration = 0) 零秒通话
    FROM user_call_order
   WHERE ${ch("create_at")} >= '${M0}' AND ${ch("create_at")} < '${M1}' AND status='PAID'
   GROUP BY 1,2,3 ORDER BY n DESC`);
console.log("order_type    收费    单数      均时长秒  均免费额度  零秒通话");
a.forEach((r) => console.log(`  ${String(r.order_type).padEnd(12)}${String(r.kind).padEnd(16)}${String(r.n).padStart(8)}${String(r["均时长秒"]).padStart(9)}${String(r["均免费额度秒"] ?? "—").padStart(11)}${String(r["零秒通话"]).padStart(9)}`));

console.log("\n=== 2) 平均通话时长的四种口径（7月全平台）===");
const d = await query(`
  SELECT
    round(avg(call_duration) FILTER (WHERE order_type IN ('VIDEO_CALL','MOCK_VIDEO'))::numeric,1) 含mock,
    round(avg(call_duration) FILTER (WHERE order_type='VIDEO_CALL')::numeric,1) 不含mock,
    round(avg(call_duration) FILTER (WHERE order_type='VIDEO_CALL' AND call_duration>0)::numeric,1) 不含mock_去0秒,
    round(avg(call_duration) FILTER (WHERE order_type='VIDEO_CALL' AND NULLIF(amount,'')::numeric>0)::numeric,1) 仅付费视频
    FROM user_call_order
   WHERE ${ch("create_at")} >= '${M0}' AND ${ch("create_at")} < '${M1}' AND status='PAID'`);
const x = d[0];
console.log(`  含 MOCK_VIDEO            ${x["含mock"]} 秒`);
console.log(`  不含 MOCK（当前 CSV 用的）${x["不含mock"]} 秒`);
console.log(`  不含 MOCK + 去掉 0 秒通话 ${x["不含mock_去0秒"]} 秒`);
console.log(`  仅付费视频(amount>0)      ${x["仅付费视频"]} 秒`);

console.log("\n=== 3) 复访基数：通话男性 vs 付费男性 ===");
const r = await query(`
  WITH pair AS (
    SELECT female_user_id f, male_user_id m,
           count(DISTINCT ${ch("create_at")}::date) days,
           sum(NULLIF(amount,'')::numeric) amt
      FROM user_call_order
     WHERE ${ch("create_at")} >= '${M0}' AND ${ch("create_at")} < '${M1}'
       AND status='PAID' AND order_type='VIDEO_CALL'
     GROUP BY 1,2)
  SELECT count(*) 通话男性对数,
         count(*) FILTER (WHERE days>=2) 通话复访,
         count(*) FILTER (WHERE amt>0) 付费男性对数,
         count(*) FILTER (WHERE amt>0 AND days>=2) 付费复访
    FROM pair`);
const p = r[0];
console.log(`  通话男性(女×男 配对) ${p["通话男性对数"]} → 复访 ${p["通话复访"]}（${(p["通话复访"]/p["通话男性对数"]*100).toFixed(1)}%）  ← CSV 当前口径`);
console.log(`  付费男性(amount>0)   ${p["付费男性对数"]} → 复访 ${p["付费复访"]}（${(p["付费复访"]/p["付费男性对数"]*100).toFixed(1)}%）`);
