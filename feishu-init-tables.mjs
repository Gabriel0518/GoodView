// 飞书多维表格一键建表（幂等）：Base 内缺哪张表就建哪张，已存在的跳过。
// 依赖 FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_APP_TOKEN（见 FEISHU-SETUP.md）。
// 用法：node feishu-init-tables.mjs
import { listTables, createTable } from "./lib/feishu.mjs";
import { TABLES } from "./feishu-tables.mjs";
import { FEISHU } from "./config.mjs";

async function main() {
  if (!FEISHU.appToken) {
    console.error("缺少 FEISHU_APP_TOKEN。请先建好 Base 并把 app_token 填进 .env（见 FEISHU-SETUP.md）。");
    process.exit(1);
  }
  console.log(`[飞书建表] Base=${FEISHU.appToken} · campaign 粒度=${FEISHU.campaignGrain}`);
  const existing = new Set((await listTables()).map((t) => t.name));

  for (const t of TABLES) {
    if (existing.has(t.name)) {
      console.log(`  ⏭  已存在，跳过：${t.name}`);
      continue;
    }
    try {
      const id = await createTable(t.name, t.fields);
      console.log(`  ✅ 已创建：${t.name}（${t.fields.length} 字段）table_id=${id}`);
    } catch (e) {
      console.error(`  ❌ 创建失败：${t.name} — ${e.message}`);
      process.exitCode = 1;
    }
  }
  console.log("[飞书建表] 完成。接着运行同步：node sync-to-feishu.mjs");
}

main().catch((e) => {
  console.error("建表失败：", e.message);
  process.exit(1);
});
