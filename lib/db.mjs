// Postgres 连接层（供 .mjs 拉取脚本用）。读 DATABASE_URL。
import pg from "pg";
import { DATABASE_URL } from "../config.mjs";
import { isTransient } from "./http.mjs";

if (!DATABASE_URL) {
  console.error("缺少 DATABASE_URL（在 .env 或环境变量里设置）");
}

// 托管 PG（Railway 等）需要 SSL；本地 localhost 不需要
const isLocal = /localhost|127\.0\.0\.1/.test(DATABASE_URL);
const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 5,
  keepAlive: true,
});
// Railway 公网 proxy 会掐断空闲连接 → pool 对空闲 client 抛 error 事件。
// 不监听会让进程崩（unhandled 'error'）。这里吞掉，让下次 connect 拿新连接。
pool.on("error", (e) => console.warn(`  ⚠️ PG 空闲连接错误（已忽略）：${e.message}`));

// 瞬时错误重试：Railway 公网 proxy 偶发掐连接（"Connection terminated unexpectedly" 等）。
// 命中判定复用 lib/http.mjs 的 isTransient（与 xmp/byteplus 同源，避免正则漂移）。
// 指数退避，最多 ~28s，够渡过 proxy 的短暂罢工窗口。
async function withRetry(fn, retries = 6) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i === retries || !isTransient(e)) throw e;
      await new Promise((r) => setTimeout(r, Math.min(800 * 2 ** i, 8000)));
    }
  }
  throw lastErr;
}

export const query = (text, params) => withRetry(() => pool.query(text, params));

export async function withTx(fn) {
  // 整个事务作为一个重试单元：瞬时掐断 → 回滚 → 重连重跑。
  // 调用方的写入必须幂等（如按日期 DELETE+INSERT），重跑才安全。
  return withRetry(async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  });
}

// 多行插入（unnest：数组作参数，避开 65535 参数上限）。大批量按 batchSize 分批。
export async function bulkInsert(client, table, columns, rows, batchSize = 5000) {
  if (!rows.length) return;
  const cols = columns.map((c) => c.name).join(", ");
  const selects = columns.map((c, i) => `$${i + 1}::${c.type}[]`).join(", ");
  const sql = `INSERT INTO ${table} (${cols}) SELECT * FROM unnest(${selects})`;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const params = columns.map((c) => batch.map((r) => r[c.name]));
    await client.query(sql, params);
  }
}

export const end = () => pool.end();
