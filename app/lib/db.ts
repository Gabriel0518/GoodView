import { Pool } from "pg";

// 单例连接池（Next 热重载/多路由复用，避免重复建池）
const url = process.env.DATABASE_URL || "";
const isLocal = /localhost|127\.0\.0\.1/.test(url);

const g = globalThis as unknown as { _pgPool?: Pool };
export const pool =
  g._pgPool ??
  (g._pgPool = new Pool({
    connectionString: url,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: 5,
  }));

export function q<T extends Record<string, unknown> = Record<string, unknown>>(text: string, params?: unknown[]) {
  return pool.query<T>(text, params as never);
}

// 单连接顺序执行：避免同时开多条到 Railway 公网 proxy 的 SSL 连接（会被 drop）
export async function withClient<T>(fn: (c: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
