// Postgres 连接层（供 .mjs 拉取脚本用）。读 DATABASE_URL。
import pg from "pg";
import { DATABASE_URL } from "../config.mjs";

if (!DATABASE_URL) {
  console.error("缺少 DATABASE_URL（在 .env 或环境变量里设置）");
}

// 托管 PG（Railway 等）需要 SSL；本地 localhost 不需要
const isLocal = /localhost|127\.0\.0\.1/.test(DATABASE_URL);
const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 5,
});

export const query = (text, params) => pool.query(text, params);

export async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
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
