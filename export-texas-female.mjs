// 德州女端用户名单导出（CSV，含 user_id）
//   主文件：最近30天有动作的德州女端（新注册 / 有收入 / IG绑定 三层并集，用列标记归属哪层）
//   附文件：全历史德州女端存量
// 德州判据沿用已验证口径：档案地/邮编为主(一致率99.7%)，IP 兜底，指向他州则一票否决
// ⚠️ 超过 1000 行必须用 queryAll 分页（DMS 硬上限，超出静默截断）
import { queryAll, bool } from "./lib/dms.mjs";
import { writeFileSync } from "node:fs";

const TX_CITY = `^(Houston|Dallas|San Antonio|Austin|Fort Worth|El Paso|Arlington|Corpus Christi|Plano|Laredo|Lubbock|Garland|Irving|Amarillo|Brownsville|McKinney|Frisco|Killeen|Waco|Denton|Midland|Odessa|Beaumont|Round Rock|Richardson|College Station|Sugar Land|Carrollton|Pearland|Mesquite|League City|Baytown|Conroe|Edinburg|Harlingen|Galveston|San Marcos|New Braunfels)$`;
const PREF = `btrim(u.preferred_location, '" ')`;
const P_TX = `${PREF} ~* '(^|,)\\s*Texas\\s*$'`;
const P_NEG = `(${PREF} ~* ',\\s*[A-Za-z][A-Za-z .]+\\s*$' AND ${PREF} !~* '(^|,)\\s*Texas\\s*$')`;
const Z_TX = `(u.zip_code ~ '^[0-9]{5}' AND (substring(u.zip_code,1,5)::int BETWEEN 75000 AND 79999
   OR substring(u.zip_code,1,5)::int BETWEEN 88500 AND 88599))`;
const Z_NEG = `(u.zip_code ~ '^[0-9]{5}' AND NOT ${Z_TX})`;
const IP_TX = `EXISTS (SELECT 1 FROM user_geo_location g WHERE g.user_id=u.user_id AND g.province='Texas')`;
const IPC_TX = `EXISTS (SELECT 1 FROM user_geo_location g WHERE g.user_id=u.user_id
   AND (g.province IS NULL OR g.province IN ('0','')) AND g.city ~* '${TX_CITY}')`;
// 命中德州且未被一票否决
const IS_TX = `((${P_TX}) OR (${Z_TX}) OR (((${IP_TX}) OR (${IPC_TX})) AND NOT ((${P_NEG}) OR (${Z_NEG}))))`;

const cols = `
  u.user_id, u.face_score, u.age, u.user_source, u.zip_code, u.preferred_location,
  u.created_at::date::text reg_date, u.is_face_verified,
  (${P_TX}) s_pref, (${Z_TX}) s_zip, (${IP_TX}) s_ip, (${IPC_TX}) s_ipcity,
  (SELECT g.province||' / '||COALESCE(g.city,'') FROM user_geo_location g
     WHERE g.user_id=u.user_id LIMIT 1) ip_loc,
  (u.created_at >= now() - interval '30 days') is_new,
  EXISTS (SELECT 1 FROM user_common_task t WHERE t.user_id=u.user_id
     AND t.task_id='110' AND t.status='FINISHED') ig_ever,
  EXISTS (SELECT 1 FROM user_common_task t WHERE t.user_id=u.user_id AND t.task_id='110'
     AND t.status='FINISHED' AND t.update_at >= now() - interval '30 days') ig_30d,
  COALESCE((SELECT round(sum(h.balance_change::numeric),2) FROM pwa_user_balance_change_history h
     WHERE h.to_user_id=u.user_id AND h.created_at >= now() - interval '30 days'),0) income_30d,
  COALESCE((SELECT round(sum(h.balance_change::numeric),2) FROM pwa_user_balance_change_history h
     WHERE h.to_user_id=u.user_id AND h.created_at >= now() - interval '180 days'),0) income_180d`;

const BASE = `u.app_name='3' AND u.gender=2 AND u.deleted_at IS NULL AND ${IS_TX}`;

const conf = (r) => (bool(r.s_pref) && bool(r.s_zip) ? "高" : bool(r.s_pref) || bool(r.s_zip) ? "中" : "低");
const ev = (r) => [bool(r.s_pref) && "档案地", bool(r.s_zip) && "邮编", bool(r.s_ip) && "IP州",
  bool(r.s_ipcity) && "IP城市"].filter(Boolean).join("+");
const q = (v) => `"${String(v ?? "").replace(/"/g, "")}"`;
const yn = (v) => (bool(v) ? "是" : "否");

const HDR = "user_id,face_score,age,置信度,德州证据,档案地,zip_code,IP定位,近30天新注册,近30天完成IG绑定,曾完成IG绑定,近30天收入USD,近180天收入USD,已人脸验证,来源,注册日";
const line = (r) => [r.user_id, r.face_score ?? "", r.age ?? "", conf(r), ev(r), q(r.preferred_location),
  r.zip_code ?? "", q(r.ip_loc), yn(r.is_new), yn(r.ig_30d), yn(r.ig_ever),
  r.income_30d, r.income_180d, yn(r.is_face_verified), r.user_source ?? "", r.reg_date].join(",");

// —— 主文件：最近30天有动作（注册/收入/IG绑定 任一）——
const recent = await queryAll(
  `SELECT ${cols} FROM userinfo u WHERE ${BASE} AND (
      u.created_at >= now() - interval '30 days'
      OR EXISTS (SELECT 1 FROM user_common_task t WHERE t.user_id=u.user_id AND t.task_id='110'
           AND t.status='FINISHED' AND t.update_at >= now() - interval '30 days')
      OR EXISTS (SELECT 1 FROM pwa_user_balance_change_history h WHERE h.to_user_id=u.user_id
           AND h.created_at >= now() - interval '30 days' AND h.balance_change::numeric > 0))`,
  { orderBy: "user_id" });
recent.sort((a, b) => Number(b.income_30d) - Number(a.income_30d));
writeFileSync("德州女端-近30天.csv", [HDR, ...recent.map(line)].join("\n"));

// —— 附文件：全历史存量 ——
const all = await queryAll(`SELECT ${cols} FROM userinfo u WHERE ${BASE}`, { orderBy: "user_id" });
all.sort((a, b) => Number(b.income_180d) - Number(a.income_180d));
writeFileSync("德州女端-全历史.csv", [HDR, ...all.map(line)].join("\n"));

const stat = (rows, label) => {
  const c = (f) => rows.filter(f).length;
  console.log(`\n${label}：${rows.length} 人`);
  console.log(`  置信度  高 ${c((r) => conf(r) === "高")} · 中 ${c((r) => conf(r) === "中")} · 低(仅IP) ${c((r) => conf(r) === "低")}`);
  console.log(`  face_score >=80  ${c((r) => Number(r.face_score) >= 80)} 人`);
  console.log(`  近30天新注册 ${c((r) => bool(r.is_new))} · 近30天IG绑定 ${c((r) => bool(r.ig_30d))} · 曾IG绑定 ${c((r) => bool(r.ig_ever))}`);
  console.log(`  近30天有收入 ${c((r) => Number(r.income_30d) > 0)} 人，合计 $${rows.reduce((a, r) => a + Number(r.income_30d), 0).toFixed(2)}`);
};
stat(recent, "【主文件】德州女端-近30天.csv");
stat(all, "【附文件】德州女端-全历史.csv");

console.log(`\n预览（近30天，按30天收入降序）：`);
console.log("user_id    face 置信 近30天收入  新注册 IG绑定  档案地");
recent.slice(0, 12).forEach((r) => console.log(
  `${String(r.user_id).padEnd(11)}${String(r.face_score ?? "—").padEnd(5)}${conf(r).padEnd(4)}${String(r.income_30d).padStart(10)}    ${yn(r.is_new)}    ${yn(r.ig_30d)}   ${String(r.preferred_location || "—").replace(/"/g, "")}`));
