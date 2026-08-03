// 四种德州信号的交叉一致性 —— 决定用哪个/怎么合并
import { query } from "./lib/dms.mjs";
import { readFileSync } from "node:fs";
const IN = readFileSync("top-earners-face80-ids.txt", "utf8").trim().split("\n").join(",");

const TX_CITY = `^(Houston|Dallas|San Antonio|Austin|Fort Worth|El Paso|Arlington|Corpus Christi|Plano|Laredo|Lubbock|Garland|Irving|Amarillo|Brownsville|McKinney|Frisco|Pasadena|Killeen|Waco|Denton|Midland|Abilene|Odessa|Beaumont|Round Rock|Richardson|Tyler|College Station|Sugar Land|Carrollton|Pearland|Mesquite|League City|Allen|Baytown|Conroe|Edinburg|Mission|Bryan|Longview|Temple|Harlingen|Galveston|San Marcos|Georgetown|New Braunfels)$`;

const rows = await query(`
  SELECT u.user_id,
    (u.preferred_location ~* ',\\s*Texas\\s*$') AS s_pref,
    (u.zip_code ~ '^[0-9]{5}' AND (substring(u.zip_code,1,5)::int BETWEEN 75000 AND 79999
       OR substring(u.zip_code,1,5)::int BETWEEN 88500 AND 88599)) AS s_zip,
    EXISTS (SELECT 1 FROM user_geo_location g WHERE g.user_id=u.user_id
       AND (g.province='Texas' OR g.city ~* '${TX_CITY}')) AS s_geo,
    (u.latitude BETWEEN 25.83 AND 36.51 AND u.longitude BETWEEN -106.66 AND -93.50) AS s_bbox,
    -- 「明确不是德州」的反证：三个强信号里有任何一个指向别的州
    (u.preferred_location ~* ',\\s*[A-Za-z ]+$' AND u.preferred_location !~* ',\\s*Texas\\s*$') AS neg_pref,
    (u.zip_code ~ '^[0-9]{5}' AND NOT (substring(u.zip_code,1,5)::int BETWEEN 75000 AND 79999
       OR substring(u.zip_code,1,5)::int BETWEEN 88500 AND 88599)) AS neg_zip
  FROM userinfo u WHERE u.user_id IN (${IN})`);

const B = (v) => v === true || v === "true" || v === "t";
const n = (f) => rows.filter(f).length;

console.log(`队列 ${rows.length} 人 —— 四种德州信号各自命中：`);
console.log(`  preferred_location 尾部是 Texas   ${n((r) => B(r.s_pref))}`);
console.log(`  zip 落德州邮编区间                ${n((r) => B(r.s_zip))}`);
console.log(`  geo 表 province/城市是德州        ${n((r) => B(r.s_geo))}`);
console.log(`  经纬度落德州包围盒(弱,含邻州)     ${n((r) => B(r.s_bbox))}`);

const strong = (r) => B(r.s_pref) || B(r.s_zip) || B(r.s_geo);
console.log(`\n三个强信号「任一命中」：${n(strong)} 人`);
console.log(`三个强信号「全部一致命中」：${n((r) => B(r.s_pref) && B(r.s_zip) && B(r.s_geo))} 人`);

console.log(`\n=== 强信号两两一致性（都有值的前提下）===`);
const pair = (a, b, na, nb, la, lb) => {
  const both = rows.filter((r) => (B(r[a]) || B(r[na])) && (B(r[b]) || B(r[nb])));
  const agree = both.filter((r) => B(r[a]) === B(r[b])).length;
  console.log(`  ${la} vs ${lb}: 都有值 ${both.length} 人，一致 ${agree} (${(agree/both.length*100).toFixed(1)}%)`);
};
pair("s_pref", "s_zip", "neg_pref", "neg_zip", "preferred_location", "zip");

console.log(`\n=== 只被单一信号命中的（需人工判断）===`);
for (const r of rows.filter(strong)) {
  const hits = [B(r.s_pref) && "pref", B(r.s_zip) && "zip", B(r.s_geo) && "geo"].filter(Boolean);
  if (hits.length === 1) console.log(`  ${r.user_id}  仅 ${hits[0]}`);
}
