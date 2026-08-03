// pwa_user_balance_change_history 口径：change_type 含义、金额符号、谁是收款方
import { query } from "./lib/dms.mjs";

console.log("=== change_type 分布（近180天）===");
const t = await query(`
  SELECT change_type,
         count(*) n,
         count(DISTINCT to_user_id) to_users,
         count(DISTINCT from_user_id) from_users,
         min(balance_change::numeric) mn,
         max(balance_change::numeric) mx,
         round(sum(balance_change::numeric),2) total
    FROM pwa_user_balance_change_history
   WHERE created_at >= now() - interval '180 days'
   GROUP BY 1 ORDER BY n DESC`);
console.log("change_type                 笔数      收方人数  付方人数   最小      最大        合计");
for (const r of t)
  console.log(`  ${String(r.change_type).padEnd(26)}${String(r.n).padStart(9)}${String(r.to_users).padStart(10)}${String(r.from_users).padStart(9)}${String(r.mn).padStart(9)}${String(r.mx).padStart(11)}${String(r.total).padStart(13)}`);

console.log("\n=== 样本行 ===");
const s = await query(`SELECT id, from_user_id, to_user_id, balance_change, left_balance, change_type,
    created_at::text FROM pwa_user_balance_change_history
   WHERE created_at >= now() - interval '30 days' ORDER BY id DESC LIMIT 6`);
s.forEach((r) => console.log(`  ${r.created_at.slice(0,19)} from=${r.from_user_id} to=${r.to_user_id} 变动=${r.balance_change} 余额=${r.left_balance} 类型=${r.change_type}`));

console.log("\n=== to_user_id 是不是女端？（与 gender 交叉）===");
const g = await query(`
  SELECT u.gender, count(DISTINCT h.to_user_id) n
    FROM pwa_user_balance_change_history h JOIN userinfo u ON u.user_id = h.to_user_id
   WHERE h.created_at >= now() - interval '180 days' GROUP BY 1 ORDER BY n DESC`);
g.forEach((r) => console.log(`  收款方 gender=${r.gender}: ${r.n} 人`));
