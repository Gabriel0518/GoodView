import { Client } from "pg";

// 每次请求新建连接（connect→用→end），避免连接池里的空闲连接被 Railway 公网 proxy 掐断
// 后产生 "Connection terminated unexpectedly"。低流量看板，握手开销可忽略。
// 生产用 Railway 内网 DATABASE_URL 时更稳（不走公网 proxy）。
const url = process.env.DATABASE_URL || "";
const isLocal = /localhost|127\.0\.0\.1/.test(url);
const ssl = isLocal ? false : { rejectUnauthorized: false };

async function connect() {
  const client = new Client({ connectionString: url, ssl, keepAlive: true });
  await client.connect();
  return client;
}

// Railway 公网 proxy 偶发掐连接（Connection terminated / ECONNRESET）→ 瞬时错误重试。
// 指数退避最多 ~28s，够渡过 proxy 短暂罢工（与脚本层 lib/db.mjs 同策略）。
const TRANSIENT = /terminated|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|socket hang up/i;
async function withRetry<T>(fn: () => Promise<T>, retries = 6): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i === retries || !TRANSIENT.test(String((e as Error)?.message || e))) throw e;
      await new Promise((r) => setTimeout(r, Math.min(800 * 2 ** i, 8000)));
    }
  }
  throw lastErr;
}

// 单连接上顺序执行多条查询（getSnapshot/getFunnel 用）
export async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  return withRetry(async () => {
    const client = await connect();
    try {
      return await fn(client);
    } finally {
      await client.end().catch(() => {});
    }
  });
}

// 单条查询（getStatus / groups 等用）
export async function q<T extends Record<string, unknown> = Record<string, unknown>>(text: string, params?: unknown[]) {
  return withRetry(async () => {
    const client = await connect();
    try {
      return await client.query<T>(text, params as never);
    } finally {
      await client.end().catch(() => {});
    }
  });
}
