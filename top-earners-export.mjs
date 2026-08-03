// 最终名单导出：PWA女端 · face_score>80 · 近180天曾有某月收入进前20%
import { query, bool } from "./lib/dms.mjs";
import { writeFileSync } from "node:fs";

const TZ = "America/Chicago";
const day = (c) => `((${c} AT TIME ZONE 'UTC') AT TIME ZONE '${TZ}')`;
const NOISE = `('PWA_USER_BALANCE_CHANGE_TYPE_SPIN_COST','PWA_USER_BALANCE_CHANGE_TYPE_SPIN_WIN',
  'PWA_USER_BALANCE_CHANGE_TYPE_SPIN_NOT_ENOUGH_REWARD','PWA_USER_BALANCE_CHANGE_TYPE_ONBOARDING_TASK',
  'PWA_USER_BALANCE_CHANGE_TYPE_DAILY_TASK','PWA_USER_BALANCE_CHANGE_TYPE_WAITING_REWARD',
  'PWA_USER_BALANCE_CHANGE_TYPE_MOCK_VIDEO','PWA_USER_BALANCE_CHANGE_TYPE_BFF_REWARD')`;

const rows = await query(`
  WITH monthly AS (
    SELECT h.to_user_id user_id, to_char(date_trunc('month', ${day("h.created_at")}),'YYYY-MM') ym,
           sum(h.balance_change::numeric) income
      FROM pwa_user_balance_change_history h
      JOIN userinfo u ON u.user_id=h.to_user_id AND u.app_name='3' AND u.gender=2
     WHERE h.created_at >= now() - interval '180 days'
     GROUP BY 1,2 HAVING sum(h.balance_change::numeric) > 0),
  ranked AS (SELECT user_id, ym, income,
      ntile(5) OVER (PARTITION BY ym ORDER BY income DESC) q FROM monthly),
  top AS (SELECT user_id, count(*) hit_months, string_agg(ym,' ' ORDER BY ym) months,
                 round(max(income),2) best_month_income
            FROM ranked WHERE q=1 GROUP BY user_id),
  -- 严格口径：剔除转盘/平台奖励/MOCK 后是否仍进前20%
  monthly_s AS (
    SELECT h.to_user_id user_id, to_char(date_trunc('month', ${day("h.created_at")}),'YYYY-MM') ym,
           sum(h.balance_change::numeric) income
      FROM pwa_user_balance_change_history h
      JOIN userinfo u ON u.user_id=h.to_user_id AND u.app_name='3' AND u.gender=2
     WHERE h.created_at >= now() - interval '180 days' AND h.change_type NOT IN ${NOISE}
     GROUP BY 1,2 HAVING sum(h.balance_change::numeric) > 0),
  top_s AS (SELECT DISTINCT user_id FROM (
      SELECT user_id, ntile(5) OVER (PARTITION BY ym ORDER BY income DESC) q FROM monthly_s) x WHERE q=1)
  SELECT t.user_id, u.face_score, u.age, u.user_source, u.zip_code,
         t.hit_months, t.months, t.best_month_income,
         (u.deleted_at IS NOT NULL) AS deleted,
         (s.user_id IS NOT NULL) AS strict_ok,
         u.is_face_verified, u.created_at::date::text AS reg_date
    FROM top t
    JOIN userinfo u ON u.user_id = t.user_id
    LEFT JOIN top_s s ON s.user_id = t.user_id
   WHERE u.face_score > 80
   ORDER BY t.best_month_income DESC`);

const live = rows.filter((r) => !bool(r.deleted));
const strict = live.filter((r) => bool(r.strict_ok));
console.log(`名单：${rows.length} 人（有效 ${live.length} · 已注销 ${rows.length - live.length}）`);
console.log(`  其中严格口径(剔除转盘/平台奖励/MOCK)仍入选：${strict.length} 人`);
console.log(`\n入选月份数分布：`);
const byN = {};
live.forEach((r) => { byN[r.hit_months] = (byN[r.hit_months] || 0) + 1; });
Object.keys(byN).sort((a,b)=>b-a).forEach((k) => console.log(`  ${k} 个月进过前20%：${byN[k]} 人`));

const hdr = "user_id,face_score,age,user_source,zip_code,进前20%月数,月份,最高月收入USD,严格口径也入选,已人脸验证,注册日";
const csv = [hdr, ...rows.map((r) => [r.user_id, r.face_score, r.age ?? "", r.user_source ?? "", r.zip_code ?? "",
  r.hit_months, r.months, r.best_month_income, bool(r.strict_ok) ? "是" : "否",
  bool(r.is_face_verified) ? "是" : "否", r.reg_date].join(","))].join("\n");
writeFileSync("top-earners-face80.csv", csv);
console.log(`\n✅ 已导出 top-earners-face80.csv（${rows.length} 行，含已注销并标记）`);

console.log(`\nTop 20 预览：`);
console.log("user_id    face  最高月收入   月数  来源     月份");
live.slice(0, 20).forEach((r) => console.log(
  `${String(r.user_id).padEnd(11)}${String(r.face_score).padEnd(6)}${String(r.best_month_income).padStart(10)}${String(r.hit_months).padStart(6)}  ${String(r.user_source||"—").padEnd(8)} ${r.months}`));

writeFileSync("top-earners-face80-ids.txt", live.map((r) => r.user_id).join("\n"));
console.log(`\n✅ 纯 ID 列表（${live.length} 个有效用户）→ top-earners-face80-ids.txt`);
