// 摸底：在线会话表能否对上 PWA 用户 + 男性消费在哪张表
import { query } from "./lib/dms.mjs";

console.log("=== sp_v3_online_session 覆盖情况 ===");
const p = await query(`SELECT platform, count(*) n, count(DISTINCT creator_id) users,
    min(connected_at)::date::text d0, max(connected_at)::date::text d1
  FROM sp_v3_online_session GROUP BY 1 ORDER BY n DESC`);
p.forEach((r) => console.log(`  platform=${String(r.platform).padEnd(8)} ${r.n} 行 · ${r.users} 人 · ${r.d0} ~ ${r.d1}`));

const m = await query(`
  SELECT count(DISTINCT s.creator_id) total,
         count(DISTINCT s.creator_id) FILTER (WHERE u.user_id IS NOT NULL) matched,
         count(DISTINCT s.creator_id) FILTER (WHERE u.app_name='3') pwa
    FROM sp_v3_online_session s
    LEFT JOIN userinfo u ON u.user_id::text = s.creator_id
   WHERE s.connected_at >= '2026-07-01' AND s.connected_at < '2026-08-01'`);
console.log(`  7月有会话的 creator ${m[0].total} 个 → 能对上 userinfo ${m[0].matched} 个 → 其中 PWA ${m[0].pwa} 个`);

console.log("\n=== 男性消费候选表（近30天有数据的）===");
for (const t of ["user_coins_buy_transactions", "payment_record", "unified_payment_orders",
  "user_transaction", "user_ios_transaction_history", "user_android_transaction_history", "user_coins"]) {
  try {
    const c = await query(`SELECT column_name,data_type FROM information_schema.columns
       WHERE table_name='${t}' ORDER BY ordinal_position`);
    if (!c.length) { console.log(`  ${t}: 表不存在`); continue; }
    const tcol = c.find((x) => /create|time|date/i.test(x.column_name) && /timestamp/.test(x.data_type));
    let cnt = "?";
    if (tcol) {
      const n = await query(`SELECT count(*) n FROM ${t} WHERE ${tcol.column_name} >= '2026-07-01' AND ${tcol.column_name} < '2026-08-01'`);
      cnt = n[0].n;
    }
    console.log(`  ${t}  [7月 ${cnt} 行]`);
    console.log(`     列: ${c.map((x) => x.column_name).join(", ").slice(0, 160)}`);
  } catch (e) { console.log(`  ${t}: ${e.message.slice(0, 60)}`); }
}
