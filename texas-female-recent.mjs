// 最近一个月的德州女端规模（沿用已验证的德州识别口径，分层）
import { query } from "./lib/dms.mjs";

const TX_CITY = `^(Houston|Dallas|San Antonio|Austin|Fort Worth|El Paso|Arlington|Corpus Christi|Plano|Laredo|Lubbock|Garland|Irving|Amarillo|Brownsville|McKinney|Frisco|Killeen|Waco|Denton|Midland|Odessa|Beaumont|Round Rock|Richardson|College Station|Sugar Land|Carrollton|Pearland|Mesquite|League City|Baytown|Conroe|Edinburg|Harlingen|Galveston|San Marcos|New Braunfels)$`;
const PREF = `btrim(u.preferred_location, '" ')`;
const ZIP_TX = `(u.zip_code ~ '^[0-9]{5}' AND (substring(u.zip_code,1,5)::int BETWEEN 75000 AND 79999
   OR substring(u.zip_code,1,5)::int BETWEEN 88500 AND 88599))`;

// 德州置信度：与 cohort-export.mjs 完全同一套判据，搬进 SQL 以便聚合
const CONF = `CASE
  WHEN (${PREF} ~* '(^|,)\\s*Texas\\s*$') AND ${ZIP_TX} THEN '高'
  WHEN (${PREF} ~* '(^|,)\\s*Texas\\s*$') OR ${ZIP_TX} THEN '中'
  WHEN (EXISTS (SELECT 1 FROM user_geo_location g WHERE g.user_id=u.user_id AND g.province='Texas')
     OR EXISTS (SELECT 1 FROM user_geo_location g WHERE g.user_id=u.user_id
          AND (g.province IS NULL OR g.province IN ('0','')) AND g.city ~* '${TX_CITY}'))
   THEN CASE WHEN (${PREF} ~* ',\\s*[A-Za-z][A-Za-z .]+\\s*$' AND ${PREF} !~* '(^|,)\\s*Texas\\s*$')
               OR (u.zip_code ~ '^[0-9]{5}' AND NOT ${ZIP_TX}) THEN '排除' ELSE '低' END
  ELSE NULL END`;

const CH = `((h.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Chicago')`;

const seg = async (label, extra) => {
  const r = await query(`
    SELECT ${CONF} conf, count(*) n,
           count(*) FILTER (WHERE u.face_score >= 80) n80
      FROM userinfo u
     WHERE u.app_name='3' AND u.gender=2 AND u.deleted_at IS NULL ${extra}
     GROUP BY 1`);
  const g = (c) => Number(r.find((x) => x.conf === c)?.n || 0);
  const g80 = (c) => Number(r.find((x) => x.conf === c)?.n80 || 0);
  const rec = g("高") + g("中"), rec80 = g80("高") + g80("中");
  const all = r.reduce((a, x) => a + Number(x.n), 0);
  console.log(`\n${label}`);
  console.log(`  女端总数 ${all}`);
  console.log(`  德州(高+中，推荐口径) ${rec} 人  占 ${(rec / all * 100).toFixed(1)}%`);
  console.log(`     └ 高 ${g("高")} · 中 ${g("中")} · 低(仅IP) ${g("低")} · 假阳性剔除 ${g("排除")}`);
  console.log(`  其中 face_score>=80：${rec80} 人（占德州 ${rec ? (rec80 / rec * 100).toFixed(1) : 0}%）`);
  return { rec, rec80 };
};

console.log("=== 德州女端规模（沿用已验证的德州识别口径）===");
await seg("【全历史】全体 PWA 女端", "");
await seg("【最近30天新注册】", "AND u.created_at >= now() - interval '30 days'");
await seg("【最近30天有正收入（活跃创收）】",
  `AND EXISTS (SELECT 1 FROM pwa_user_balance_change_history h
      WHERE h.to_user_id=u.user_id AND h.created_at >= now() - interval '30 days'
        AND h.balance_change::numeric > 0)`);
await seg("【最近30天完成 IG 绑定】",
  `AND EXISTS (SELECT 1 FROM user_common_task t WHERE t.user_id=u.user_id
      AND t.task_id='110' AND t.status='FINISHED' AND t.update_at >= now() - interval '30 days')`);

// 完整队列口径（face>=80 + 当月进前20%）落到最近一个自然月
console.log("\n\n=== 完整队列口径（face>=80 且当月收入进前20%）——按自然月 ===");
const m = await query(`
  WITH mon AS (
    SELECT h.to_user_id user_id, to_char(date_trunc('month',${CH}),'YYYY-MM') ym,
           sum(h.balance_change::numeric) income
      FROM pwa_user_balance_change_history h
      JOIN userinfo x ON x.user_id=h.to_user_id AND x.app_name='3' AND x.gender=2
     WHERE h.created_at >= now() - interval '180 days'
     GROUP BY 1,2 HAVING sum(h.balance_change::numeric) > 0),
  ranked AS (SELECT user_id, ym, ntile(5) OVER (PARTITION BY ym ORDER BY income DESC) q FROM mon)
  SELECT r.ym, count(*) top20,
         count(*) FILTER (WHERE u.face_score >= 80) top20_face80,
         count(*) FILTER (WHERE u.face_score >= 80 AND ${CONF} IN ('高','中')) tx_face80
    FROM ranked r JOIN userinfo u ON u.user_id=r.user_id
   WHERE r.q=1 AND u.deleted_at IS NULL
   GROUP BY r.ym ORDER BY r.ym`);
console.log("月份      当月前20%   其中face>=80   其中德州(高+中)");
m.forEach((r) => console.log(
  `  ${r.ym}${String(r.top20).padStart(10)}${String(r.top20_face80).padStart(14)}${String(r.tx_face80).padStart(16)}`));
