// 飞书多维表格一键建表（幂等）：Base 内缺哪张表就建哪张，已存在的**补齐缺失字段**。
// 依赖 FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_APP_TOKEN（见 FEISHU-SETUP.md）。
// 用法：node feishu-init-tables.mjs
import { listTables, createTable, listFields, createField, tableIdMap } from "./lib/feishu.mjs";
import { applyViewSort, ruleText } from "./lib/view-sort.mjs";
import { buildTables, CONFIG_TABLES } from "./feishu-tables.mjs";
import { FEISHU } from "./config.mjs";

// 给已存在的表补上定义里新增、飞书里还没有的字段（只加不改不删：改类型/删列有丢数风险，交给人工）。
// 没有这一步，给表加一列就得手动去飞书点——sync 会因为「字段不存在」把该列静默丢掉。
async function addMissingFields(t, tableId) {
  const have = new Set((await listFields(tableId)).map((f) => f.field_name));
  const missing = t.fields.filter((f) => !have.has(f.field_name));
  for (const f of missing) await createField(tableId, f);
  return missing.map((f) => f.field_name);
}

async function main() {
  if (!FEISHU.appToken) {
    console.error("缺少 FEISHU_APP_TOKEN。请先建好 Base 并把 app_token 填进 .env（见 FEISHU-SETUP.md）。");
    process.exit(1);
  }
  console.log(`[飞书建表] Base=${FEISHU.appToken} · campaign 粒度=${FEISHU.campaignGrain}`);
  const existing = new Set((await listTables()).map((t) => t.name));
  const ids = await tableIdMap();

  // 镜像表 + 配置表A（配置表A 只建表、不参与 Postgres→飞书 推送）
  const all = [...(await buildTables()), ...CONFIG_TABLES];
  for (const t of all) {
    if (existing.has(t.name)) {
      try {
        const added = await addMissingFields(t, ids[t.name]);
        console.log(added.length
          ? `  ➕ 已存在，补字段：${t.name} — ${added.join("、")}`
          : `  ⏭  已存在，跳过：${t.name}`);
      } catch (e) {
        console.error(`  ❌ 补字段失败：${t.name} — ${e.message}`);
        process.exitCode = 1;
      }
      continue;
    }
    try {
      const id = await createTable(t.name, t.fields);
      // 新表立刻挂上「日期降序」视图排序：增量同步是追加式的，靠插入顺序永远排不对。
      // 缺 base:view:write_only 权限只警告不失败——建表本身已经成功，排序可以事后补挂。
      const s = await applyViewSort(id);
      const note = s.errors.length ? `（排序未设置：需 base:view:write_only）` : s.rule ? `· 排序 ${ruleText(s.rule)}` : "";
      console.log(`  ✅ 已创建：${t.name}（${t.fields.length} 字段）table_id=${id} ${note}`);
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
