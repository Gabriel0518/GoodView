// 6/1~7/31 花费账户盘点：确定哪些属于 PWA（历史数据里混着白名单启用前的全部账户）
import { query, end } from "./lib/db.mjs";

const { rows } = await query(`
  SELECT account_id, MAX(account_name) AS nm, SUM(cost)::numeric(10,0) AS cost,
         MIN(date)::text AS d0, MAX(date)::text AS d1,
         string_agg(DISTINCT campaign_name, ' / ') FILTER (WHERE cost > 0) AS camps
    FROM campaign_daily WHERE date BETWEEN '2026-06-01' AND '2026-07-31' AND cost > 0
   GROUP BY account_id HAVING SUM(cost) > 300 ORDER BY cost DESC LIMIT 40`);

console.log("6/1~7/31 花费 > $300 的账户（★ = 名称或系列含 pwa/sitin）:\n");
let pwaSum = 0, otherSum = 0;
for (const r of rows) {
  const blob = `${r.nm || ""} ${r.camps || ""}`;
  const isPwa = /pwa|sitin/i.test(blob);
  if (isPwa) pwaSum += Number(r.cost); else otherSum += Number(r.cost);
  console.log(`${isPwa ? "★" : " "} ${String(r.nm).padEnd(28)} $${String(r.cost).padStart(7)}  ${r.d0}~${r.d1}  ${String(r.camps || "").slice(0, 46)}`);
}
console.log(`\n★PWA 合计 $${pwaSum}   其它 $${otherSum}`);
await end();
