// 德州名单 v2 —— 修 v1 两个 bug：
//   1) 档案地正则 `,\s*Texas$` 漏掉裸 "Texas"（无城市前缀）→ 真德州用户被降级
//   2) IP 城市名跨州撞名（Longview 德州/华盛顿州都有）→ 假阳性
//      改为：IP 只认 province='Texas'；城市名匹配必须 province 为空/'0' 才启用；
//      且档案地/邮编若明确指向别的州 → 一票否决
import { query, bool } from "./lib/dms.mjs";
import { readFileSync, writeFileSync } from "node:fs";
const IN = readFileSync("top-earners-face80-ids.txt", "utf8").trim().split("\n").join(",");

const TX_CITY = `^(Houston|Dallas|San Antonio|Austin|Fort Worth|El Paso|Arlington|Corpus Christi|Plano|Laredo|Lubbock|Garland|Irving|Amarillo|Brownsville|McKinney|Frisco|Killeen|Waco|Denton|Midland|Odessa|Beaumont|Round Rock|Richardson|College Station|Sugar Land|Carrollton|Pearland|Mesquite|League City|Baytown|Conroe|Edinburg|Harlingen|Galveston|San Marcos|New Braunfels)$`;

const rows = await query(`
  WITH mon AS (
    SELECT h.to_user_id user_id,
           to_char(date_trunc('month',((h.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Chicago')),'YYYY-MM') ym,
           sum(h.balance_change::numeric) income
      FROM pwa_user_balance_change_history h
     WHERE h.to_user_id IN (${IN}) AND h.created_at >= now() - interval '180 days'
     GROUP BY 1,2 HAVING sum(h.balance_change::numeric) > 0)
  SELECT u.user_id, u.face_score, u.age, u.preferred_location, u.zip_code, u.user_source,
         u.created_at::date::text reg_date,
         -- 档案地是德州：允许 "City, Texas" 和裸 "Texas"；值里可能带引号(302 人)，先 btrim 剥掉
         (btrim(u.preferred_location, '" ') ~* '(^|,)\\s*Texas\\s*$') s_pref,
         -- 档案地明确是别的州（有州名但不是 Texas）→ 反证
         (btrim(u.preferred_location, '" ') ~* ',\\s*[A-Za-z][A-Za-z .]+\\s*$'
            AND btrim(u.preferred_location, '" ') !~* '(^|,)\\s*Texas\\s*$') neg_pref,
         (u.zip_code ~ '^[0-9]{5}' AND (substring(u.zip_code,1,5)::int BETWEEN 75000 AND 79999
            OR substring(u.zip_code,1,5)::int BETWEEN 88500 AND 88599)) s_zip,
         (u.zip_code ~ '^[0-9]{5}' AND NOT (substring(u.zip_code,1,5)::int BETWEEN 75000 AND 79999
            OR substring(u.zip_code,1,5)::int BETWEEN 88500 AND 88599)) neg_zip,
         -- IP：province 明确是 Texas 才算强；城市名只在 province 缺失时兜底
         EXISTS (SELECT 1 FROM user_geo_location g WHERE g.user_id=u.user_id AND g.province='Texas') s_ip,
         EXISTS (SELECT 1 FROM user_geo_location g WHERE g.user_id=u.user_id
            AND (g.province IS NULL OR g.province IN ('0','')) AND g.city ~* '${TX_CITY}') s_ipcity,
         (SELECT g.province||' / '||COALESCE(g.city,'') FROM user_geo_location g
            WHERE g.user_id=u.user_id LIMIT 1) ip_loc,
         (SELECT round(max(m.income),2) FROM mon m WHERE m.user_id=u.user_id) best_income,
         (SELECT count(*) FROM mon m WHERE m.user_id=u.user_id) active_months
    FROM userinfo u WHERE u.user_id IN (${IN})`);

const out = [];
for (const r of rows) {
  const p = bool(r.s_pref), z = bool(r.s_zip), ip = bool(r.s_ip), ipc = bool(r.s_ipcity);
  const np = bool(r.neg_pref), nz = bool(r.neg_zip);
  if (!p && !z && !ip && !ipc) continue;
  // 一票否决：自填档案明确指向别的州，且没有任何自填信号支持德州
  if (!p && !z && (np || nz)) { out.push({ ...r, conf: "排除", ev: "IP命中但档案地/邮编指向他州" }); continue; }
  const ev = [p && "档案地", z && "邮编", ip && "IP州", ipc && "IP城市"].filter(Boolean).join("+");
  const conf = p && z ? "高" : p || z ? "中" : "低";
  out.push({ ...r, conf, ev });
}
const keep = out.filter((r) => r.conf !== "排除").sort((a, b) => Number(b.best_income) - Number(a.best_income));
const dropped = out.filter((r) => r.conf === "排除");
const by = (c) => keep.filter((r) => r.conf === c);

console.log(`514 人队列 → 德州 ${keep.length} 人（另剔除 ${dropped.length} 个假阳性）`);
console.log(`  高置信 档案地+邮编都指向德州   ${by("高").length} 人`);
console.log(`  中置信 档案地或邮编其一        ${by("中").length} 人`);
console.log(`  低置信 仅 IP 定位且无反证      ${by("低").length} 人`);
console.log(`  → 推荐口径 高+中 = ${by("高").length + by("中").length} 人\n`);

if (dropped.length) {
  console.log("剔除的假阳性（IP 说德州，但自填档案是别的州）：");
  dropped.forEach((r) => console.log(`  ${r.user_id}  档案地=${r.preferred_location || "—"}  zip=${r.zip_code || "—"}  IP=${r.ip_loc || "—"}`));
}

console.log(`\n=== 德州名单（按最高月收入降序）===`);
console.log("user_id    face 最高月收入 月数 置信 证据            档案地");
keep.forEach((r) => console.log(
  `${String(r.user_id).padEnd(11)}${String(r.face_score).padEnd(5)}${String(r.best_income).padStart(10)}${String(r.active_months).padStart(5)}  ${r.conf}  ${r.ev.padEnd(15)} ${r.preferred_location || "—"}`));

const hdr = "user_id,face_score,age,置信度,德州证据,档案地,zip_code,IP定位,最高月收入USD,有收入月数,来源,注册日";
writeFileSync("top-earners-face80-texas.csv",
  [hdr, ...keep.map((r) => [r.user_id, r.face_score, r.age ?? "", r.conf, r.ev,
    `"${r.preferred_location ?? ""}"`, r.zip_code ?? "", `"${r.ip_loc ?? ""}"`,
    r.best_income ?? "", r.active_months, r.user_source ?? "", r.reg_date].join(","))].join("\n"));
const rec = keep.filter((r) => r.conf !== "低");
writeFileSync("top-earners-face80-texas-ids.txt", rec.map((r) => r.user_id).join("\n"));
console.log(`\n✅ top-earners-face80-texas.csv（${keep.length} 行，含置信度列）`);
console.log(`✅ top-earners-face80-texas-ids.txt（${rec.length} 个，高+中置信）`);
