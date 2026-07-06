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

// 单连接上顺序执行多条查询（getSnapshot/getFunnel 用）
export async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

// 单条查询（getStatus 用）
export async function q<T extends Record<string, unknown> = Record<string, unknown>>(text: string, params?: unknown[]) {
  const client = await connect();
  try {
    return await client.query<T>(text, params as never);
  } finally {
    await client.end().catch(() => {});
  }
}
