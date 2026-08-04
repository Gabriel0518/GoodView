// 德州 · 7月收入前20% 女性用户明细
//
// 口径（全部实测确认，见 git log）：
//   队列    = PWA(app_name=3) 女端(gender=2)，2026-07(芝加哥月)净进账>0，按收入降序 ntile(5)=1
//   德州    = 档案地/邮编为主(两者一致率99.7%)，IP 兜底；档案地或邮编指向他州则一票否决
//   通话    = user_call_order status='PAID' AND order_type='VIDEO_CALL'（MOCK_VIDEO 已排除）
//   付费/免费 = amount>0 / amount=0（amount=0 表示落在 free_call_duration 60 秒额度内，她没赚到）
//   在线    = sp_v3_online_session.duration_ms，按 connected_at 落在 7 月内 → 单月口径
//   男性消费 = unified_payment_orders status IN ('SUCCESS','ACTIVE')，全平台充值非仅对她
//   付费男性留存 = 以该男性自己的注册日为起点，第 N 日当天是否有通话记录；
//                 分母只含「注册满 N 天」的男性，否则新注册的会把 D30 拉低
import { queryAll, query, bool } from "./lib/dms.mjs";
import { writeFileSync } from "node:fs";

const TZ = "America/Chicago";
const M0 = "2026-07-01", M1 = "2026-08-01";
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
         (${P_TX}) s_pref, (${Z_TX}) s_zip
    FROM rk r JOIN userinfo u ON u.user_id=r.user_id
   WHERE r.q=1 AND u.deleted_at IS NULL AND ${IS_TX}`, { orderBy: "user_id" });

const ids = base.map((r) => r.user_id);
console.log(`7月收入前20% ∩ 德州：${ids.length} 人`);
const IN = ids.join(",");

const call = await query(`
  SELECT female_user_id uid, count(*) calls,
         count(*) FILTER (WHERE COALESCE(NULLIF(amount,'')::numeric,0) > 0) paid_calls,
         count(*) FILTER (WHERE COALESCE(NULLIF(amount,'')::numeric,0) = 0) free_calls,
         count(*) FILTER (WHERE call_duration = 0) zero_calls,
         round(avg(call_duration)::numeric,1) avg_all,
         round(avg(call_duration) FILTER (WHERE call_duration > 0)::numeric,1) avg_nonzero,
         round(avg(call_duration) FILTER (WHERE COALESCE(NULLIF(amount,'')::numeric,0) > 0)::numeric,1) avg_paid,
         sum(call_duration) total_sec,
         sum(call_duration) FILTER (WHERE COALESCE(NULLIF(amount,'')::numeric,0) > 0) paid_sec,
         count(DISTINCT male_user_id) males
    FROM user_call_order
   WHERE female_user_id IN (${IN}) AND status='PAID' AND order_type='VIDEO_CALL'
     AND ${ch("create_at")} >= '${M0}' AND ${ch("create_at")} < '${M1}'
   GROUP BY 1`);

const online = await query(`
  SELECT creator_id uid, round(sum(duration_ms)/3600000.0, 2) hours, count(*) sessions
    FROM sp_v3_online_session
   WHERE creator_id IN ('${ids.join("','")}')
     AND ${ch("connected_at")} >= '${M0}' AND ${ch("connected_at")} < '${M1}'
   GROUP BY 1`);

// 男性侧：复访 + 消费 + ARPU + 付费男性的注册留存(D1/D7/D30)
const male = await query(`
  WITH pair AS (
    SELECT female_user_id f, male_user_id m,
           count(DISTINCT ${ch("create_at")}::date) days,
           COALESCE(sum(NULLIF(amount,'')::numeric),0) amt
      FROM user_call_order
     WHERE female_user_id IN (${IN}) AND status='PAID' AND order_type='VIDEO_CALL'
       AND ${ch("create_at")} >= '${M0}' AND ${ch("create_at")} < '${M1}'
     GROUP BY 1,2),
  aug AS (
    SELECT DISTINCT female_user_id f, male_user_id m FROM user_call_order
     WHERE female_user_id IN (${IN}) AND status='PAID' AND order_type='VIDEO_CALL'
       AND ${ch("create_at")} >= '${M1}'),
  spend AS (
    SELECT user_id, sum(amount::numeric) s FROM unified_payment_orders
     WHERE status IN ('SUCCESS','ACTIVE')
       AND ${ch("created_at")} >= '${M0}' AND ${ch("created_at")} < '${M1}'
     GROUP BY 1),
  -- 付费男性的注册日 + 各留存窗口是否已满
  mreg AS (
    SELECT DISTINCT p.m, ${ch("u.created_at")}::date rd
      FROM pair p JOIN userinfo u ON u.user_id = p.m
     WHERE p.amt > 0),
  -- 男性活跃日 = 有通话记录的日期（男性侧最丰富的活跃信号）
  act AS (
    SELECT c.male_user_id m, ${ch("c.create_at")}::date d
      FROM user_call_order c
     WHERE c.male_user_id IN (SELECT m FROM mreg)
     GROUP BY 1,2),
  ret AS (
    SELECT r.m, r.rd,
      (r.rd + 1  <= ${ch("now()")}::date) d1_ok,
      (r.rd + 7  <= ${ch("now()")}::date) d7_ok,
      (r.rd + 30 <= ${ch("now()")}::date) d30_ok,
      EXISTS (SELECT 1 FROM act a WHERE a.m=r.m AND a.d = r.rd + 1)  d1,
      EXISTS (SELECT 1 FROM act a WHERE a.m=r.m AND a.d = r.rd + 7)  d7,
      EXISTS (SELECT 1 FROM act a WHERE a.m=r.m AND a.d = r.rd + 30) d30
      FROM mreg r)
  SELECT p.f uid,
         count(*) males,
         count(*) FILTER (WHERE p.days>=2) repeat_males,
         count(*) FILTER (WHERE p.amt>0) paid_males,
         count(*) FILTER (WHERE p.amt>0 AND p.days>=2) paid_repeat,
         count(*) FILTER (WHERE a.m IS NOT NULL) aug_males,
         round(COALESCE(sum(sp.s),0),2) male_spend,
         count(*) FILTER (WHERE sp.s IS NOT NULL) paying_males,
         count(*) FILTER (WHERE t.d1_ok)  d1_base, count(*) FILTER (WHERE t.d1_ok AND t.d1)  d1_ret,
         count(*) FILTER (WHERE t.d7_ok)  d7_base, count(*) FILTER (WHERE t.d7_ok AND t.d7)  d7_ret,
         count(*) FILTER (WHERE t.d30_ok) d30_base,count(*) FILTER (WHERE t.d30_ok AND t.d30) d30_ret
    FROM pair p
    LEFT JOIN aug a ON a.f=p.f AND a.m=p.m
    LEFT JOIN spend sp ON sp.user_id=p.m
    LEFT JOIN ret t ON t.m=p.m
   GROUP BY 1`);

const idx = (a) => Object.fromEntries(a.map((r) => [String(r.uid), r]));
const C = idx(call), O = idx(online), M = idx(male);
const pct = (a, b) => (Number(b) > 0 ? (Number(a) / Number(b) * 100).toFixed(1) + "%" : "");
const mins = (s) => (s ? (Number(s) / 60).toFixed(1) : "");

let rows = base.map((b) => {
  const u = String(b.user_id), c = C[u] || {}, o = O[u] || {}, m = M[u] || {};
  const males = Number(m.males || 0), spend = Number(m.male_spend || 0);
  const p = bool(b.s_pref), z = bool(b.s_zip);
  return {
    user_id: u,
    全量收入排名: b.rnk,
    七月收入USD: b.income_jul,
    德州置信度: p && z ? "高" : p || z ? "中" : "低",
    档案地: (b.preferred_location || "").replace(/"/g, ""),
    face_score: b.face_score ?? "",
    年龄: b.age ?? "",
    来源: b.user_source ?? "",
    注册日: b.reg_date,
    // —— 视频通话（已排除 MOCK_VIDEO）——
    视频总数: Number(c.calls || 0),
    付费视频数: Number(c.paid_calls || 0),
    免费视频数: Number(c.free_calls || 0),
    零秒通话数: Number(c.zero_calls || 0),
    均时长_全部秒: c.avg_all ?? "",
    均时长_去0秒: c.avg_nonzero ?? "",
    均时长_仅付费秒: c.avg_paid ?? "",
    通话总时长分钟: mins(c.total_sec),
    付费通话时长分钟: mins(c.paid_sec),
    // —— 在线（7月单月）——
    七月在线小时: o.hours ?? "",
    在线会话数: o.sessions ?? "",
    // —— 男性侧 ——
    通话男性数: males,
    付费男性数: Number(m.paid_males || 0),
    男性消费总额USD: spend.toFixed(2),
    ARPU: males ? (spend / males).toFixed(2) : "",
    ARPPU: Number(m.paying_males) ? (spend / Number(m.paying_males)).toFixed(2) : "",
    // —— 复访（对她本人）——
    通话男性复访率: pct(m.repeat_males, males),
    付费男性复访率: pct(m.paid_repeat, m.paid_males),
    八月回访率: pct(m.aug_males, males),
    // —— 付费男性自身的注册留存 ——
    付费男性次日留存: pct(m.d1_ret, m.d1_base),
    付费男性7日留存: pct(m.d7_ret, m.d7_base),
    付费男性30日留存: pct(m.d30_ret, m.d30_base),
    留存样本数_D30: Number(m.d30_base || 0),
  };
});
rows.sort((a, b) => Number(b.七月收入USD) - Number(a.七月收入USD));
rows = rows.map((r, i) => ({ user_id: r.user_id, 德州排名: i + 1, ...r }));

const hdr = Object.keys(rows[0]);
const esc = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, "")}"` : s; };
writeFileSync("德州-7月收入前20%-明细.csv",
  "﻿" + [hdr.join(","), ...rows.map((r) => hdr.map((h) => esc(r[h])).join(","))].join("\n"));

const n = (f) => rows.filter(f).length;
const avg = (f) => { const v = rows.map(f).filter((x) => Number.isFinite(x) && x > 0); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; };
console.log(`\n覆盖率：通话 ${n((r) => r.视频总数 > 0)}/${rows.length} · 在线 ${n((r) => r.七月在线小时 !== "")}/${rows.length} · 男性消费 ${n((r) => Number(r.男性消费总额USD) > 0)}/${rows.length}`);
console.log(`\n队列均值：`);
console.log(`  7月收入 $${avg((r) => Number(r.七月收入USD)).toFixed(2)}`);
console.log(`  视频数 ${avg((r) => r.视频总数).toFixed(0)}（付费 ${avg((r) => r.付费视频数).toFixed(0)} / 免费 ${avg((r) => r.免费视频数).toFixed(0)}）`);
console.log(`  均时长  全部 ${avg((r) => Number(r.均时长_全部秒)).toFixed(1)}s · 去0秒 ${avg((r) => Number(r.均时长_去0秒)).toFixed(1)}s · 仅付费 ${avg((r) => Number(r.均时长_仅付费秒)).toFixed(1)}s`);
console.log(`  7月在线 ${avg((r) => Number(r.七月在线小时)).toFixed(1)} 小时`);
console.log(`  通话男性 ${avg((r) => r.通话男性数).toFixed(0)} 人 · 付费男性 ${avg((r) => r.付费男性数).toFixed(0)} 人`);
console.log(`  ARPU $${avg((r) => Number(r.ARPU)).toFixed(2)} · ARPPU $${avg((r) => Number(r.ARPPU)).toFixed(2)}`);
console.log(`  复访  通话男性 ${avg((r) => parseFloat(r.通话男性复访率)).toFixed(1)}% · 付费男性 ${avg((r) => parseFloat(r.付费男性复访率)).toFixed(1)}%`);
console.log(`  付费男性注册留存  D1 ${avg((r) => parseFloat(r.付费男性次日留存)).toFixed(1)}% · D7 ${avg((r) => parseFloat(r.付费男性7日留存)).toFixed(1)}% · D30 ${avg((r) => parseFloat(r.付费男性30日留存)).toFixed(1)}%`);
console.log(`\n✅ 德州-7月收入前20%-明细.csv（${rows.length} 行 × ${hdr.length} 字段，含 BOM 便于 Excel 打开）`);
console.log(`\nTop 10：`);
console.log("德州 全量  user_id     7月收入  付费视频 免费视频 均时长(付费) 在线h  付费男性  ARPU  D1/D7/D30");
rows.slice(0, 10).forEach((r) => console.log(
  `${String(r.德州排名).padStart(3)}${String(r.全量收入排名).padStart(5)}  ${r.user_id.padEnd(10)}${String(r.七月收入USD).padStart(9)}${String(r.付费视频数).padStart(8)}${String(r.免费视频数).padStart(8)}${String(r.均时长_仅付费秒).padStart(10)}s${String(r.七月在线小时 || "—").padStart(8)}${String(r.付费男性数).padStart(8)}${String(r.ARPU).padStart(7)}  ${r.付费男性次日留存}/${r.付费男性7日留存}/${r.付费男性30日留存}`));
