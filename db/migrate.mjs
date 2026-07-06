// 建表 + 播种 funnel_stage_meta。部署时先跑一次：node db/migrate.mjs
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DATABASE_URL } from "../config.mjs";
import { query, end } from "../lib/db.mjs";
import { FUNNEL } from "../funnel-events.mjs";

async function main() {
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL 为空。请在 .env 里设置（本地 Postgres 或 Railway 的连接串），再重试。");
  }
  console.log(`连接 ${DATABASE_URL.replace(/:[^:@/]+@/, ":****@")} …`);

  // 1) 建表（幂等）
  const schema = await readFile(path.join(process.cwd(), "db", "schema.sql"), "utf8");
  await query(schema);
  console.log("✅ schema 已应用");

  // 2) 播种 funnel_stage_meta（ord = FUNNEL 数组顺序）
  let n = 0;
  for (let ord = 0; ord < FUNNEL.length; ord++) {
    const s = FUNNEL[ord];
    const filters = s.filters ? JSON.stringify(s.filters) : null;
    await query(
      `INSERT INTO funnel_stage_meta (stage_key, ord, label, event_name, filters, updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb, now())
       ON CONFLICT (stage_key) DO UPDATE SET
         ord = EXCLUDED.ord, label = EXCLUDED.label,
         event_name = EXCLUDED.event_name, filters = EXCLUDED.filters, updated_at = now()`,
      [s.key, ord, s.label, s.name, filters],
    );
    n++;
  }
  console.log(`✅ funnel_stage_meta 已播种 ${n} 个阶段`);

  await end();
}

main().catch(async (e) => {
  console.error("迁移失败：");
  console.error("  message:", e?.message || "(空)");
  console.error("  code   :", e?.code || "-");
  if (e?.cause) console.error("  cause  :", e.cause);
  console.error("  stack  :", e?.stack || e);
  await end().catch(() => {});
  process.exit(1);
});
