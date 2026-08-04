// 德州 · 7月收入前20% 女性用户明细导出
// 口径：
//   队列  = PWA(app_name=3) 女端(gender=2)，2026-07 芝加哥月内净进账 > 0，按收入降序 ntile(5)=1
//   德州  = 档案地/邮编为主(一致率99.7%)，IP 兜底，指向他州一票否决
//   通话  = user_call_order status='PAID' AND order_type='VIDEO_CALL'，call_duration 单位秒
//   在线  = sp_v3_online_session.duration_ms（仅覆盖用 IG 托管的创作者，见输出末尾覆盖率）
//   男性  = 7月与她 PAID 视频通话过的 male_user_id
//   消费  = unified_payment_orders status IN ('SUCCESS','ACTIVE')，全平台消费非仅对她
import { queryAll, query, bool } from "./lib/dms.mjs";
import { writeFileSync } from "node:fs";

const TZ = "America/Chicago";
const M0 = "2026-07-01", M1 = "2026-08-01";     // 7月 [M0, M1)
const ch = (c) => `((${c} AT TIME ZONE 'UTC') AT TIME ZONE '${TZ}')`;
const TX_CITY = `^(Houston|Dallas|San Antonio|Austin|Fort Worth|El Paso|Arlington|Corpus Christi|Plano|Laredo|Lubbock|Garland|Irving|Amarillo|Brownsville|McKinney|Frisco|Killeen|Waco|Denton|Midland|Odessa|Beaumont|Round Rock|Richardson|College Station|Sugar Land|Carrollton|Pearland|Mesquite|League City|Baytown|Conroe|Edinburg|Harlingen|Galveston|San Marcos|New Braunfels)$`;
const PREF = `btrim(u.preferred_location, '" ')`;
const P_TX = `${PREF} ~* '(^|,)\\s*Texas\\s*$'`;
const P_NEG = `(${PREF} ~* ',\\s*[A-Za-z][A-Za-z .]+\\s*$' AND NOT ${P_TX})`;
const Z_TX = `(u.zip_code ~ '^[0-9]{5}' AND (substring(u.zip_code,1,5)::int BETWEEN 75000 AND 79999
   OR substring(u.zip_code,1,5)::int BETWEEN 88500 AND 88599))`;
const Z_NEG = `(u.zip_code ~ '^[0-9]{5}' AND NOT ${Z_TX})`;
const IP_TX = `EXISTS (SELECT 1 FROM user_geo_location g WHERE g.user_id=u.user_id AND g.province='Texas')`;
const IPC_TX = `EXISTS (SELECT 1 FROM user_geo_location g WHERE g.user_id=u.user_id
   AND (g.province IS NULL OR g.province IN ('0','')) AND g.city ~* '${TX_CITY}')`;
const IS_TX = `((${P_TX}) OR (${Z_TX}) OR (((${IP_TX}) OR (${IPC_TX})) AND NOT ((${P_NEG}) OR (${Z_NEG}))))`;

// —— 1) 队列：7月收入前20% ∩ 德州 ——
const base = await queryAll(`
  WITH inc AS (
    SELECT h.to_user_id user_id, sum(h.balance_change::numeric) income
      FROM pwa_user_balance_change_history h
      JOIN userinfo x ON x.user_id=h.to_user_id AND x.app_name='3' AND x.gender=2
     WHERE ${ch("h.created_at")} >= '${M0}' AND ${ch("h.created_at")} < '${M1}'
     GROUP BY 1 HAVING sum(h.balance_change::numeric) > 0),
  rk AS (SELECT user_id, income, ntile(5) OVER (ORDER BY income DESC) q,
                rank() OVER (ORDER BY income DESC) rnk FROM inc)
  SELECT r.user_id, round(r.income,2) income_jul, r.rnk,
         u.face_score, u.age, u.user_source, u.preferred_location, u.zip_code,
         u.created_at::date::text reg_date,
         (${P_TX}) s_pref, (${Z_TX}) s_zip, (${IP_TX}) s_ip, (${IPC_TX}) s_ipcity
    FROM rk r JOIN userinfo u ON u.user_id=r.user_id
   WHERE r.q=1 AND u.deleted_at IS NULL AND ${IS_TX}`, { orderBy: "user_id" });

const ids = base.map((r) => r.user_id);
console.log(`7月收入前20% ∩ 德州：${ids.length} 人`);
if (!ids.length) process.exit(0);
const IN = ids.join(",");

// —— 2) 通话（7月，PAID 视频通话）——
const call = await query(`
  SELECT female_user_id uid, count(*) calls,
         round(avg(call_duration)::numeric,1) avg_sec,
         sum(call_duration) total_sec,
         count(DISTINCT male_user_id) males,
         round(sum(NULLIF(amount,'')::numeric),2) her_earn
    FROM user_call_order
   WHERE female_user_id IN (${IN}) AND status='PAID' AND order_type='VIDEO_CALL'
     AND ${ch("create_at")} >= '${M0}' AND ${ch("create_at")} < '${M1}'
   GROUP BY 1`);

// —— 3) 在线时长（7月）——
const online = await query(`
  SELECT creator_id uid, round(sum(duration_ms)/3600000.0, 2) hours, count(*) sessions
    FROM sp_v3_online_session
   WHERE creator_id IN ('${ids.join("','")}')
     AND ${ch("connected_at")} >= '${M0}' AND ${ch("connected_at")} < '${M1}'
   GROUP BY 1`);

// —— 4) 男性侧：留存 + 消费 + ARPU ——
const male = await query(`
  WITH pair AS (
    SELECT DISTINCT female_user_id f, male_user_id m
      FROM user_call_order
     WHERE female_user_id IN (${IN}) AND status='PAID' AND order_type='VIDEO_CALL'
       AND ${ch("create_at")} >= '${M0}' AND ${ch("create_at")} < '${M1}'),
  -- 7月内复访：与同一位女性在 ≥2 个不同日期通话
  repeat AS (
    SELECT female_user_id f, male_user_id m
      FROM user_call_order
     WHERE female_user_id IN (${IN}) AND status='PAID' AND order_type='VIDEO_CALL'
       AND ${ch("create_at")} >= '${M0}' AND ${ch("create_at")} < '${M1}'
     GROUP BY 1,2 HAVING count(DISTINCT ${ch("create_at")}::date) >= 2),
  -- 8月回访（截至今天，天数不足一个月，仅作参考）
  aug AS (
    SELECT DISTINCT female_user_id f, male_user_id m
      FROM user_call_order
     WHERE female_user_id IN (${IN}) AND status='PAID' AND order_type='VIDEO_CALL'
       AND ${ch("create_at")} >= '${M1}'),
  spend AS (
    SELECT user_id, sum(amount::numeric) s
      FROM unified_payment_orders
     WHERE status IN ('SUCCESS','ACTIVE')
       AND ${ch("created_at")} >= '${M0}' AND ${ch("created_at")} < '${M1}'
     GROUP BY 1)
  SELECT p.f uid,
         count(*) males,
         count(*) FILTER (WHERE r.m IS NOT NULL) repeat_males,
         count(*) FILTER (WHERE a.m IS NOT NULL) aug_males,
         round(COALESCE(sum(sp.s),0),2) male_spend,
         count(*) FILTER (WHERE sp.s IS NOT NULL) paying_males
    FROM pair p
    LEFT JOIN repeat r ON r.f=p.f AND r.m=p.m
    LEFT JOIN aug a ON a.f=p.f AND a.m=p.m
    LEFT JOIN spend sp ON sp.user_id=p.m
   GROUP BY 1`);

const idx = (arr, k = "uid") => Object.fromEntries(arr.map((r) => [String(r[k]), r]));
const C = idx(call), O = idx(online), M = idx(male);

const rows = base.map((b) => {
  const u = String(b.user_id), c = C[u] || {}, o = O[u] || {}, m = M[u] || {};
  const males = Number(m.males || 0), spend = Number(m.male_spend || 0);
  const p = bool(b.s_pref), z = bool(b.s_zip);
  return {
    user_id: u,
    收入排名: b.rnk,
    七月收入USD: b.income_jul,
    face_score: b.face_score ?? "",
    年龄: b.age ?? "",
    德州置信度: p && z ? "高" : p || z ? "中" : "低",
    档案地: (b.preferred_location || "").replace(/"/g, ""),
    通话数: c.calls ?? 0,
    平均每次通话秒: c.avg_sec ?? "",
    通话总时长分钟: c.total_sec ? (Number(c.total_sec) / 60).toFixed(1) : "",
    在线时长小时: o.hours ?? "",
    在线会话数: o.sessions ?? "",
    通话男性数: males,
    男性复访数: Number(m.repeat_males || 0),
    七月内复访率: males ? (Number(m.repeat_males || 0) / males * 100).toFixed(1) + "%" : "",
    八月回访数: Number(m.aug_males || 0),
    八月回访率: males ? (Number(m.aug_males || 0) / males * 100).toFixed(1) + "%" : "",
    付费男性数: Number(m.paying_males || 0),
    男性消费总额USD: spend.toFixed(2),
    ARPU: males ? (spend / males).toFixed(2) : "",
    来源: b.user_source ?? "",
    注册日: b.reg_date,
  };
});
rows.sort((a, b) => Number(b.七月收入USD) - Number(a.七月收入USD));

const hdr = Object.keys(rows[0]);
writeFileSync("德州-7月收入前20%-明细.csv",
  [hdr.join(","), ...rows.map((r) => hdr.map((h) => {
    const v = String(r[h] ?? "");
    return /[",]/.test(v) ? `"${v.replace(/"/g, "")}"` : v;
  }).join(","))].join("\n"));

const n = (f) => rows.filter(f).length;
const avg = (f) => { const v = rows.map(f).filter((x) => Number.isFinite(x) && x > 0); return v.length ? (v.reduce((a, b) => a + b, 0) / v.length) : 0; };
console.log(`  置信度 高 ${n((r) => r.德州置信度 === "高")} · 中 ${n((r) => r.德州置信度 === "中")} · 低 ${n((r) => r.德州置信度 === "低")}`);
console.log(`\n覆盖率（能取到该指标的人数）：`);
console.log(`  有通话记录        ${n((r) => r.通话数 > 0)} / ${rows.length}`);
console.log(`  有在线会话记录    ${n((r) => r.在线时长小时 !== "")} / ${rows.length}   ← sp_v3_online_session 只覆盖用 IG 托管的创作者`);
console.log(`  有男性消费数据    ${n((r) => Number(r.男性消费总额USD) > 0)} / ${rows.length}`);
console.log(`\n均值（仅统计有数的人）：`);
console.log(`  7月收入           $${avg((r) => Number(r.七月收入USD)).toFixed(2)}`);
console.log(`  平均每次通话      ${avg((r) => Number(r.平均每次通话秒)).toFixed(1)} 秒`);
console.log(`  在线时长          ${avg((r) => Number(r.在线时长小时)).toFixed(1)} 小时`);
console.log(`  通话男性数        ${avg((r) => r.通话男性数).toFixed(1)} 人`);
console.log(`  7月内复访率       ${avg((r) => parseFloat(r.七月内复访率)).toFixed(1)}%`);
console.log(`  ARPU              $${avg((r) => Number(r.ARPU)).toFixed(2)}`);
console.log(`\n✅ 德州-7月收入前20%-明细.csv（${rows.length} 行 × ${hdr.length} 字段）`);
console.log(`\nTop 12：`);
console.log("user_id     7月收入   通话数 均时长s 在线h  男性数 复访率  ARPU");
rows.slice(0, 12).forEach((r) => console.log(
  `  ${r.user_id.padEnd(10)}${String(r.七月收入USD).padStart(9)}${String(r.通话数).padStart(7)}${String(r.平均每次通话秒 || "—").padStart(8)}${String(r.在线时长小时 || "—").padStart(7)}${String(r.通话男性数).padStart(7)}${String(r.七月内复访率 || "—").padStart(8)}${String(r.ARPU || "—").padStart(8)}`));
