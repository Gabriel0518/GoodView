// 差异溯源：净进账口径下，入选者的收入构成里「非创收类型」占多少
import { query } from "./lib/dms.mjs";
const TZ = "America/Chicago";
const day = (c) => `((${c} AT TIME ZONE 'UTC') AT TIME ZONE '${TZ}')`;

const r = await query(`
  WITH monthly AS (
    SELECT h.to_user_id AS user_id, to_char(date_trunc('month', ${day("h.created_at")}),'YYYY-MM') ym,
           sum(h.balance_change::numeric) income
      FROM pwa_user_balance_change_history h
      JOIN userinfo u ON u.user_id=h.to_user_id AND u.app_name='3' AND u.gender=2
     WHERE h.created_at >= now() - interval '180 days'
     GROUP BY 1,2 HAVING sum(h.balance_change::numeric) > 0),
  top AS (SELECT DISTINCT user_id FROM (
    SELECT user_id, ntile(5) OVER (PARTITION BY ym ORDER BY income DESC) q FROM monthly) x WHERE q=1),
  sel AS (SELECT t.user_id FROM top t JOIN userinfo u ON u.user_id=t.user_id WHERE u.face_score > 80)
  SELECT h.change_type,
         round(sum(h.balance_change::numeric),2) total,
         count(DISTINCT h.to_user_id) users
    FROM pwa_user_balance_change_history h JOIN sel s ON s.user_id=h.to_user_id
   WHERE h.created_at >= now() - interval '180 days'
   GROUP BY 1 ORDER BY total DESC`);

const tot = r.reduce((a, x) => a + Number(x.total), 0);
console.log(`face_score>80 且曾进前20% 的 536 人，近180天收入构成（合计 $${tot.toFixed(2)}）：\n`);
console.log("类型                          金额($)      占比    涉及人数");
for (const x of r) {
  const pct = (Number(x.total) / tot * 100).toFixed(1);
  console.log(`  ${x.change_type.replace('PWA_USER_BALANCE_CHANGE_TYPE_','').padEnd(26)}${String(x.total).padStart(12)}${(pct+'%').padStart(9)}${String(x.users).padStart(9)}`);
}

const del = await query(`
  WITH monthly AS (
    SELECT h.to_user_id user_id, to_char(date_trunc('month', ${day("h.created_at")}),'YYYY-MM') ym,
           sum(h.balance_change::numeric) income
      FROM pwa_user_balance_change_history h
      JOIN userinfo u ON u.user_id=h.to_user_id AND u.app_name='3' AND u.gender=2
     WHERE h.created_at >= now() - interval '180 days' GROUP BY 1,2 HAVING sum(h.balance_change::numeric)>0),
  top AS (SELECT DISTINCT user_id FROM (
    SELECT user_id, ntile(5) OVER (PARTITION BY ym ORDER BY income DESC) q FROM monthly) x WHERE q=1)
  SELECT count(*) FILTER (WHERE u.deleted_at IS NOT NULL) 已注销,
         count(*) FILTER (WHERE u.deleted_at IS NULL) 有效
    FROM top t JOIN userinfo u ON u.user_id=t.user_id WHERE u.face_score > 80`);
console.log(`\n注销状态：有效 ${del[0]["有效"]} 人 · 已注销 ${del[0]["已注销"]} 人`);
