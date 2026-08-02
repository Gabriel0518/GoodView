// 找 534 线索的口径：换时区窗口 + 看 union_users 的全部维度
import { query } from "./lib/dms.mjs";

const tries = [
  ["UTC 日 7/27~8/2", "created_at >= '2026-07-27' AND created_at < '2026-08-03'"],
  ["上海日 7/27~8/2", "(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai') >= '2026-07-27' AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai') < '2026-08-03'"],
  ["芝加哥日 7/27~8/2", "(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago') >= '2026-07-27' AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago') < '2026-08-03'"],
  ["UTC 日 7/27~8/1", "created_at >= '2026-07-27' AND created_at < '2026-08-02'"],
  ["UTC 日 7/26~8/2", "created_at >= '2026-07-26' AND created_at < '2026-08-03'"],
];
console.log("union_users 行数（不同窗口口径）:");
for (const [label, w] of tries) {
  const [r] = await query(`SELECT count(*) AS n FROM union_users WHERE ${w}`);
  const n = Number(r.n);
  console.log(`  ${label.padEnd(20)} ${String(n).padStart(5)}   ${n === 534 ? "← 命中 534 ✅" : `差 ${n - 534}`}`);
}

console.log("\n按 source × status（UTC 7/27~8/2）:");
const g = await query(`
  SELECT COALESCE(source::text,'(空)') AS source, COALESCE(status::text,'(空)') AS status, count(*) AS n
    FROM union_users WHERE created_at >= '2026-07-27' AND created_at < '2026-08-03'
   GROUP BY 1,2 ORDER BY n DESC LIMIT 12`);
for (const r of g) console.log(`  ${String(r.source).padEnd(18)} ${String(r.status).padEnd(16)} ${r.n}`);

console.log("\n按天（UTC）:");
const d = await query(`
  SELECT created_at::date::text AS d, count(*) AS n FROM union_users
   WHERE created_at >= '2026-07-26' AND created_at < '2026-08-04' GROUP BY 1 ORDER BY 1`);
for (const r of d) console.log(`  ${r.d}  ${r.n}`);
