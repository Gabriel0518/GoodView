// PWA 女端 · face_score>80 · 近180天内曾有某月收入进前20%
// 口径说明：
//   女端      = userinfo.app_name='3'(PWA) AND gender=2（已验证：IG绑定/提现/face_score 全集中在这档）
//   收入      = pwa_user_balance_change_history 中该用户作为 to_user_id 的当月净进账
//   逐月      = 按芝加哥时区自然月（与看板其余口径一致）
//   前20%     = 每个自然月在「当月有正收入的全体 PWA 女端用户」里按收入降序 ntile(5)=1
//   曾经某月  = 近180天任一自然月满足即入选
import { query } from "./lib/dms.mjs";

const TZ = "America/Chicago";
const day = (c) => `((${c} AT TIME ZONE 'UTC') AT TIME ZONE '${TZ}')`;

// 收入类型口径两版：净进账(全部类型) vs 真实创收(剔除转盘/平台奖励/MOCK)
const NOISE = `('PWA_USER_BALANCE_CHANGE_TYPE_SPIN_COST','PWA_USER_BALANCE_CHANGE_TYPE_SPIN_WIN',
  'PWA_USER_BALANCE_CHANGE_TYPE_SPIN_NOT_ENOUGH_REWARD','PWA_USER_BALANCE_CHANGE_TYPE_ONBOARDING_TASK',
  'PWA_USER_BALANCE_CHANGE_TYPE_DAILY_TASK','PWA_USER_BALANCE_CHANGE_TYPE_WAITING_REWARD',
  'PWA_USER_BALANCE_CHANGE_TYPE_MOCK_VIDEO','PWA_USER_BALANCE_CHANGE_TYPE_BFF_REWARD')`;

const cte = (typeFilter) => `
  WITH monthly AS (
    SELECT h.to_user_id AS user_id,
           to_char(date_trunc('month', ${day("h.created_at")}), 'YYYY-MM') AS ym,
           sum(h.balance_change::numeric) AS income
      FROM pwa_user_balance_change_history h
      JOIN userinfo u ON u.user_id = h.to_user_id AND u.app_name='3' AND u.gender=2
     WHERE h.created_at >= now() - interval '180 days' ${typeFilter}
     GROUP BY 1,2 HAVING sum(h.balance_change::numeric) > 0
  ),
  ranked AS (
    SELECT user_id, ym, income, ntile(5) OVER (PARTITION BY ym ORDER BY income DESC) AS q
      FROM monthly
  )`;

console.log("=== 各月「当月有正收入的 PWA 女端」人数与前20%门槛 ===");
const months = await query(`${cte("")}
  SELECT ym, count(*) earners,
         round(min(income) FILTER (WHERE q=1), 2) AS top20_门槛,
         round(max(income), 2) AS 最高
    FROM ranked GROUP BY ym ORDER BY ym`);
console.log("月份      当月有收入人数   前20%门槛($)      当月最高($)");
months.forEach((r) =>
  console.log(`  ${r.ym}${String(r.earners).padStart(12)}${String(r.top20_门槛).padStart(16)}${String(r["最高"]).padStart(16)}`));

for (const [label, tf] of [["净进账(全部类型)", ""], ["真实创收(剔除转盘/平台奖励/MOCK)", `AND h.change_type NOT IN ${NOISE}`]]) {
  const r = await query(`${cte(tf)},
    top AS (SELECT DISTINCT user_id FROM ranked WHERE q=1)
    SELECT count(*) FILTER (WHERE u.face_score > 80) AS gt80,
           count(*) FILTER (WHERE u.face_score >= 80) AS ge80,
           count(*) AS top_all
      FROM top t JOIN userinfo u ON u.user_id=t.user_id`);
  console.log(`\n[${label}]  曾进前20% 共 ${r[0].top_all} 人 → 其中 face_score>80 ${r[0].gt80} 人（≥80 则 ${r[0].ge80} 人）`);
}
