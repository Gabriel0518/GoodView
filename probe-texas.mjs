// 德州识别路径摸底：对 514 人队列，看每种切法的覆盖率和一致性
import { query } from "./lib/dms.mjs";
import { readFileSync } from "node:fs";

const ids = readFileSync("top-earners-face80-ids.txt", "utf8").trim().split("\n");
const IN = ids.join(",");
console.log(`队列 ${ids.length} 人\n`);

console.log("=== 各字段覆盖率 ===");
const cov = await query(`
  SELECT count(*) n,
         count(*) FILTER (WHERE zip_code ~ '^[0-9]{5}') zip,
         count(*) FILTER (WHERE preferred_location IS NOT NULL AND preferred_location<>'') pref,
         count(*) FILTER (WHERE longitude IS NOT NULL AND latitude IS NOT NULL AND longitude<>0) latlon
    FROM userinfo WHERE user_id IN (${IN})`);
const c = cov[0];
const pct = (x) => `${x} (${(x / c.n * 100).toFixed(1)}%)`;
console.log(`  zip_code           ${pct(c.zip)}`);
console.log(`  preferred_location ${pct(c.pref)}`);
console.log(`  经纬度             ${pct(c.latlon)}`);

const geo = await query(`
  SELECT count(DISTINCT g.user_id) n,
         count(DISTINCT g.user_id) FILTER (WHERE g.province IS NOT NULL AND g.province NOT IN ('0','')) prov
    FROM user_geo_location g WHERE g.user_id IN (${IN})`);
console.log(`  user_geo_location  ${geo[0].n} 人有记录，其中 province 有效 ${geo[0].prov} 人`);

console.log("\n=== preferred_location 样例 ===");
const pl = await query(`SELECT preferred_location v, count(*) n FROM userinfo
   WHERE user_id IN (${IN}) AND preferred_location IS NOT NULL AND preferred_location<>''
   GROUP BY 1 ORDER BY n DESC LIMIT 12`);
pl.forEach((r) => console.log(`  ${String(r.v).padEnd(40)} ${r.n}`));

console.log("\n=== user_geo_location province 分布（队列内）===");
const gp = await query(`SELECT g.province v, count(DISTINCT g.user_id) n FROM user_geo_location g
   WHERE g.user_id IN (${IN}) GROUP BY 1 ORDER BY n DESC LIMIT 15`);
gp.forEach((r) => console.log(`  ${String(r.v).padEnd(28)} ${r.n}`));

console.log("\n=== 三种德州切法各命中多少 ===");
const tx = await query(`
  WITH q AS (SELECT user_id, zip_code, longitude, latitude FROM userinfo WHERE user_id IN (${IN}))
  SELECT
    count(*) FILTER (WHERE q.zip_code ~ '^[0-9]{5}' AND
      (substring(q.zip_code,1,5)::int BETWEEN 75000 AND 79999
        OR substring(q.zip_code,1,5)::int BETWEEN 88500 AND 88599)) AS by_zip,
    count(*) FILTER (WHERE q.latitude BETWEEN 25.83 AND 36.51
                       AND q.longitude BETWEEN -106.66 AND -93.50) AS by_bbox,
    count(*) FILTER (WHERE EXISTS (SELECT 1 FROM user_geo_location g
       WHERE g.user_id=q.user_id AND (g.province='Texas'
         OR g.city ~* '^(Houston|Dallas|San Antonio|Austin|Fort Worth|El Paso|Arlington|Corpus Christi|Plano|Laredo|Lubbock|Garland|Irving|Amarillo|Brownsville|McKinney|Frisco|Pasadena|Killeen|Waco|Denton|Midland|Abilene|Odessa|Beaumont|Round Rock|Richardson|Tyler|College Station|Sugar Land)$')) ) AS by_geo
  FROM q`);
console.log(`  zip 德州邮编区间     ${tx[0].by_zip} 人`);
console.log(`  经纬度落德州包围盒   ${tx[0].by_bbox} 人`);
console.log(`  geo 表 province/城市 ${tx[0].by_geo} 人`);
