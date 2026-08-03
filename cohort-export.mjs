// PWA 女端高分高收入队列导出（全量 + 德州分层），阈值可调
// 用法：node cohort-export.mjs            # 默认 face_score >= 80
//       FACE_MIN=85 node cohort-export.mjs
//
// 口径（均已实测验证，见 git log）：
//   女端   = userinfo.app_name='3'(PWA) AND gender=2
//   收入   = pwa_user_balance_change_history 按 to_user_id 的当月净进账
//   逐月   = 芝加哥时区自然月，近 180 天
//   前20%  = 每月在「当月有正收入的全体 PWA 女端」内 ntile(5)=1（不是在高分子集内排）
//   德州   = 档案地/邮编为主(一致率 99.7%)，IP 仅兜底；档案地或邮编指向他州则一票否决
import { queryAll, bool } from "./lib/dms.mjs";
import { writeFileSync } from "node:fs";

const FACE_MIN = Number(process.env.FACE_MIN || 80);
const TAG = `face${FACE_MIN}`;
const CH = `((h.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Chicago')`;
const NOISE = `('PWA_USER_BALANCE_CHANGE_TYPE_SPIN_COST','PWA_USER_BALANCE_CHANGE_TYPE_SPIN_WIN',
  'PWA_USER_BALANCE_CHANGE_TYPE_SPIN_NOT_ENOUGH_REWARD','PWA_USER_BALANCE_CHANGE_TYPE_ONBOARDING_TASK',
  'PWA_USER_BALANCE_CHANGE_TYPE_DAILY_TASK','PWA_USER_BALANCE_CHANGE_TYPE_WAITING_REWARD',
  'PWA_USER_BALANCE_CHANGE_TYPE_MOCK_VIDEO','PWA_USER_BALANCE_CHANGE_TYPE_BFF_REWARD')`;
const TX_CITY = `^(Houston|Dallas|San Antonio|Austin|Fort Worth|El Paso|Arlington|Corpus Christi|Plano|Laredo|Lubbock|Garland|Irving|Amarillo|Brownsville|McKinney|Frisco|Killeen|Waco|Denton|Midland|Odessa|Beaumont|Round Rock|Richardson|College Station|Sugar Land|Carrollton|Pearland|Mesquite|League City|Baytown|Conroe|Edinburg|Harlingen|Galveston|San Marcos|New Braunfels)$`;
const PREF = `btrim(u.preferred_location, '" ')`;
const ZIP_TX = `(u.zip_code ~ '^[0-9]{5}' AND (substring(u.zip_code,1,5)::int BETWEEN 75000 AND 79999
   OR substring(u.zip_code,1,5)::int BETWEEN 88500 AND 88599))`;

console.log(`阈值 face_score >= ${FACE_MIN}\n`);

const rows = await queryAll(`
  WITH mon AS (
    SELECT h.to_user_id user_id, to_char(date_trunc('month',${CH}),'YYYY-MM') ym,
           sum(h.balance_change::numeric) income
      FROM pwa_user_balance_change_history h
      JOIN userinfo x ON x.user_id=h.to_user_id AND x.app_name='3' AND x.gender=2
     WHERE h.created_at >= now() - interval '180 days'
     GROUP BY 1,2 HAVING sum(h.balance_change::numeric) > 0),
  ranked AS (SELECT user_id, ym, income, ntile(5) OVER (PARTITION BY ym ORDER BY income DESC) q FROM mon),
  top AS (SELECT user_id, count(*) hit_months, string_agg(ym,' ' ORDER BY ym) months,
                 round(max(income),2) best_income FROM ranked WHERE q=1 GROUP BY user_id),
  mon_s AS (
    SELECT h.to_user_id user_id, to_char(date_trunc('month',${CH}),'YYYY-MM') ym,
           sum(h.balance_change::numeric) income
      FROM pwa_user_balance_change_history h
      JOIN userinfo x ON x.user_id=h.to_user_id AND x.app_name='3' AND x.gender=2
     WHERE h.created_at >= now() - interval '180 days' AND h.change_type NOT IN ${NOISE}
     GROUP BY 1,2 HAVING sum(h.balance_change::numeric) > 0),
  top_s AS (SELECT DISTINCT user_id FROM (
      SELECT user_id, ntile(5) OVER (PARTITION BY ym ORDER BY income DESC) q FROM mon_s) v WHERE q=1)
  SELECT t.user_id, u.face_score, u.age, u.user_source, u.zip_code, u.preferred_location,
         u.created_at::date::text reg_date, t.hit_months, t.months, t.best_income,
         (u.deleted_at IS NOT NULL) deleted, (s.user_id IS NOT NULL) strict_ok,
         (${PREF} ~* '(^|,)\\s*Texas\\s*$') s_pref,
         (${PREF} ~* ',\\s*[A-Za-z][A-Za-z .]+\\s*$' AND ${PREF} !~* '(^|,)\\s*Texas\\s*$') neg_pref,
         ${ZIP_TX} s_zip,
         (u.zip_code ~ '^[0-9]{5}' AND NOT ${ZIP_TX}) neg_zip,
         EXISTS (SELECT 1 FROM user_geo_location g WHERE g.user_id=u.user_id AND g.province='Texas') s_ip,
         EXISTS (SELECT 1 FROM user_geo_location g WHERE g.user_id=u.user_id
            AND (g.province IS NULL OR g.province IN ('0','')) AND g.city ~* '${TX_CITY}') s_ipcity,
         (SELECT g.province||' / '||COALESCE(g.city,'') FROM user_geo_location g
            WHERE g.user_id=u.user_id LIMIT 1) ip_loc
    FROM top t JOIN userinfo u ON u.user_id=t.user_id
    LEFT JOIN top_s s ON s.user_id=t.user_id
   WHERE u.face_score >= ${FACE_MIN}`, { orderBy: "user_id" });
rows.sort((a, b) => Number(b.best_income) - Number(a.best_income));

const live = rows.filter((r) => !bool(r.deleted));
console.log(`全量：${rows.length} 人（有效 ${live.length} · 已注销 ${rows.length - live.length}）`);
console.log(`  严格口径(剔除转盘/平台奖励/MOCK)也入选：${live.filter((r) => bool(r.strict_ok)).length} 人`);
const byN = {};
live.forEach((r) => { byN[r.hit_months] = (byN[r.hit_months] || 0) + 1; });
console.log(`  进前20%月数：` + Object.keys(byN).sort((a, b) => b - a).map((k) => `${k}月×${byN[k]}`).join(" · "));
console.log(`  ≥3 个月的稳定高产：${live.filter((r) => Number(r.hit_months) >= 3).length} 人`);

// 德州分层
const tx = [], dropped = [];
for (const r of live) {
  const p = bool(r.s_pref), z = bool(r.s_zip), ip = bool(r.s_ip), ipc = bool(r.s_ipcity);
  if (!p && !z && !ip && !ipc) continue;
  if (!p && !z && (bool(r.neg_pref) || bool(r.neg_zip))) { dropped.push(r); continue; }
  tx.push({ ...r, conf: p && z ? "高" : p || z ? "中" : "低",
    ev: [p && "档案地", z && "邮编", ip && "IP州", ipc && "IP城市"].filter(Boolean).join("+") });
}
const by = (c) => tx.filter((r) => r.conf === c);
console.log(`\n德州：${tx.length} 人（另剔除 ${dropped.length} 个假阳性）`);
console.log(`  高 ${by("高").length} · 中 ${by("中").length} · 低 ${by("低").length}  → 推荐(高+中) ${by("高").length + by("中").length} 人`);
console.log(`  德州占比 ${(tx.length / live.length * 100).toFixed(1)}%`);
console.log(`  德州中 ≥3 个月稳定高产：${tx.filter((r) => Number(r.hit_months) >= 3 && r.conf !== "低").length} 人`);

const q = (v) => `"${String(v ?? "").replace(/"/g, "")}"`;
writeFileSync(`top-earners-${TAG}.csv`, ["user_id,face_score,age,进前20%月数,月份,最高月收入USD,严格口径也入选,档案地,zip_code,来源,注册日",
  ...live.map((r) => [r.user_id, r.face_score, r.age ?? "", r.hit_months, q(r.months), r.best_income,
    bool(r.strict_ok) ? "是" : "否", q(r.preferred_location), r.zip_code ?? "", r.user_source ?? "", r.reg_date].join(","))].join("\n"));
writeFileSync(`top-earners-${TAG}-ids.txt`, live.map((r) => r.user_id).join("\n"));
writeFileSync(`top-earners-${TAG}-texas.csv`, ["user_id,face_score,age,置信度,德州证据,档案地,zip_code,IP定位,最高月收入USD,进前20%月数,月份,严格口径也入选,来源,注册日",
  ...tx.map((r) => [r.user_id, r.face_score, r.age ?? "", r.conf, r.ev, q(r.preferred_location), r.zip_code ?? "",
    q(r.ip_loc), r.best_income, r.hit_months, q(r.months), bool(r.strict_ok) ? "是" : "否", r.user_source ?? "", r.reg_date].join(","))].join("\n"));
const rec = tx.filter((r) => r.conf !== "低");
writeFileSync(`top-earners-${TAG}-texas-ids.txt`, rec.map((r) => r.user_id).join("\n"));

console.log(`\n=== 德州名单 Top 25（按最高月收入）===`);
console.log("user_id    face 最高月收入 月数 置信 档案地");
tx.slice(0, 25).forEach((r) => console.log(
  `${String(r.user_id).padEnd(11)}${String(r.face_score).padEnd(5)}${String(r.best_income).padStart(10)}${String(r.hit_months).padStart(5)}  ${r.conf}   ${String(r.preferred_location || "—").replace(/"/g, "")}`));

console.log(`\n✅ top-earners-${TAG}.csv（${live.length}）· top-earners-${TAG}-ids.txt`);
console.log(`✅ top-earners-${TAG}-texas.csv（${tx.length}）· top-earners-${TAG}-texas-ids.txt（${rec.length}，高+中）`);
