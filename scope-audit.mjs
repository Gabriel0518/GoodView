// 一次性核对：飞书「在投广告账户」白名单 vs 实际花费（判断哪些账户真在投、归属是否对）
import { query, end } from "./lib/db.mjs";

const { rows } = await query(`
  SELECT c.account_id, MAX(c.account_name) AS acct, c.channel,
         COALESCE(SUM(c.cost) FILTER (WHERE c.date > CURRENT_DATE - 7), 0)::numeric(12,2)  AS cost7,
         COALESCE(SUM(c.cost) FILTER (WHERE c.date > CURRENT_DATE - 30), 0)::numeric(12,2) AS cost30,
         MAX(c.date) AS last_date,
         string_agg(DISTINCT c.campaign_name, ' / ') FILTER (WHERE c.date > CURRENT_DATE - 7) AS camps
    FROM campaign_daily c
   WHERE c.account_id IN (SELECT value FROM xmp_fetch_config WHERE category = 'account' AND enabled)
   GROUP BY c.account_id, c.channel
   ORDER BY cost7 DESC`);
console.log("账户名".padEnd(24), "account_id".padEnd(20), "渠道".padEnd(9), "7天花费".padStart(10), "30天".padStart(10), "最后有数", " 近7天系列");
for (const r of rows) {
  console.log(
    String(r.acct || "").padEnd(24), String(r.account_id).padEnd(20), String(r.channel).padEnd(9),
    ("$" + r.cost7).padStart(10), ("$" + r.cost30).padStart(10),
    String(r.last_date?.toISOString?.().slice(0, 10) || "-"), "", String(r.camps || "").slice(0, 70),
  );
}

// 白名单里在 campaign_daily 完全查无此账户的
const { rows: miss } = await query(`
  SELECT value, name FROM xmp_fetch_config
   WHERE category = 'account' AND enabled
     AND value NOT IN (SELECT DISTINCT account_id FROM campaign_daily)`);
if (miss.length) {
  console.log("\n⚠️ 白名单里库中查无花费记录的账户：");
  miss.forEach((m) => console.log("   ", m.value, m.name));
}

// AI公会系列
const { rows: camp } = await query(`
  SELECT c.campaign_id, MAX(c.campaign_name) AS nm, MAX(c.account_id) AS acct, MAX(c.account_name) AS acct_nm,
         COALESCE(SUM(c.cost) FILTER (WHERE c.date > CURRENT_DATE - 7), 0)::numeric(12,2) AS cost7,
         MAX(c.date) AS last_date
    FROM campaign_daily c
   WHERE c.campaign_id IN (SELECT value FROM xmp_fetch_config WHERE category = 'campaign' AND enabled)
   GROUP BY c.campaign_id ORDER BY cost7 DESC`);
console.log("\n=== 白名单广告系列（AI公会）===");
for (const r of camp) {
  console.log(String(r.nm).padEnd(26), String(r.campaign_id).padEnd(20), ("$" + r.cost7).padStart(10),
    "last=" + String(r.last_date?.toISOString?.().slice(0, 10) || "-"), " 账户:", r.acct_nm, r.acct);
}
await end();
