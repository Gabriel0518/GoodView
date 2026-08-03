// 为什么我的德州口径比看板(BytePlus loc_province_id)低 3 倍？查字段覆盖率
import { query } from "./lib/dms.mjs";
const PREF = `btrim(u.preferred_location, '" ')`;

const POP = `u.app_name='3' AND u.gender=2 AND u.deleted_at IS NULL
  AND EXISTS (SELECT 1 FROM user_common_task t WHERE t.user_id=u.user_id
     AND t.task_id='110' AND t.status='FINISHED' AND t.update_at >= now() - interval '30 days')`;

const r = await query(`
  SELECT count(*) n,
    count(*) FILTER (WHERE ${PREF} <> '' AND ${PREF} IS NOT NULL) has_pref,
    count(*) FILTER (WHERE u.zip_code ~ '^[0-9]{5}') has_zip,
    count(*) FILTER (WHERE (${PREF} <> '' AND ${PREF} IS NOT NULL) OR u.zip_code ~ '^[0-9]{5}') has_any,
    count(*) FILTER (WHERE EXISTS (SELECT 1 FROM user_geo_location g
        WHERE g.user_id=u.user_id AND g.province IS NOT NULL AND g.province NOT IN ('0',''))) has_ipprov,
    count(*) FILTER (WHERE EXISTS (SELECT 1 FROM user_geo_location g
        WHERE g.user_id=u.user_id AND g.province='Texas')) ip_texas
  FROM userinfo u WHERE ${POP}`);
const c = r[0], p = (x) => `${x} (${(x / c.n * 100).toFixed(1)}%)`;
console.log(`最近30天完成 IG 绑定的 PWA 女端：${c.n} 人\n`);
console.log("字段覆盖率：");
console.log(`  档案地 preferred_location  ${p(c.has_pref)}`);
console.log(`  zip_code                   ${p(c.has_zip)}`);
console.log(`  两者至少有一个             ${p(c.has_any)}`);
console.log(`  IP 定位 province 有效值    ${p(c.has_ipprov)}`);
console.log(`\nIP province='Texas'（最接近看板 BytePlus loc_province_id 的口径）：${p(c.ip_texas)}`);
console.log(`  → 折算日均 ${(c.ip_texas / 30).toFixed(1)} 个/天`);

console.log(`\n=== 两种口径的交叉（IP 说德州 vs 档案地/邮编说德州）===`);
const x = await query(`
  SELECT
    (EXISTS (SELECT 1 FROM user_geo_location g WHERE g.user_id=u.user_id AND g.province='Texas')) ip_tx,
    (${PREF} ~* '(^|,)\\s*Texas\\s*$' OR (u.zip_code ~ '^[0-9]{5}'
       AND (substring(u.zip_code,1,5)::int BETWEEN 75000 AND 79999
         OR substring(u.zip_code,1,5)::int BETWEEN 88500 AND 88599))) prof_tx,
    count(*) n
  FROM userinfo u WHERE ${POP} GROUP BY 1,2 ORDER BY 1 DESC, 2 DESC`);
const B = (v) => v === true || v === "true" || v === "t";
console.log("IP=德州  档案地/邮编=德州   人数");
x.forEach((r) => console.log(`  ${B(r.ip_tx) ? "是" : "否"}         ${B(r.prof_tx) ? "是" : "否"}          ${r.n}`));
