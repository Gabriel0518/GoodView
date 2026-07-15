// Postgres → 飞书多维表格 单向同步。Postgres 为权威库；飞书是给仪表盘用的镜像。
// 策略：全量替换。每次同步先清空整表，再灌入（窗口表=近 N 天按日期倒序；配置表=全部）。
//   · 飞书单表有行数上限（本项目 2 万/表）→ 只镜像近 N 天，Postgres 保全量。
//   · 清空再灌 → 飞书表 = Postgres 近 N 天，无历史残留、无重复；天然幂等。
//   · 按日期倒序插入 → 万一中途超限/中断，保住的是最近的数据（由近及远）。
// 单个表失败不影响其它表；有任一失败则退出码非 0（cron 里 pull-all 已完成，主库不受影响）。
// 用法：node sync-to-feishu.mjs [天数]   （默认 FEISHU_SYNC_DAYS）
import { query, end } from "./lib/db.mjs";
import { tableIdMap, batchCreate, batchDelete, listAllRecordIds } from "./lib/feishu.mjs";
import { buildTables } from "./feishu-tables.mjs";
import { FEISHU } from "./config.mjs";

function windowDates(days) {
  const ymd = (d) => d.toISOString().slice(0, 10);
  const today = new Date();
  const endD = new Date(today); endD.setDate(endD.getDate() - 1);   // 昨天（最后一个完整日）
  const startD = new Date(today); startD.setDate(startD.getDate() - days);
  return { from: ymd(startD), to: ymd(endD) };
}

async function syncTable(t, ids, win) {
  const tableId = ids[t.name];
  if (!tableId) throw new Error(`飞书里找不到表「${t.name}」，请先 node feishu-init-tables.mjs`);

  // 1) 读 Postgres（窗口表=近 N 天倒序；配置表=全部）
  const { text, params } = t.sql(win.from, win.to);
  const { rows } = await query(text, params);
  const records = rows.map((r) => t.toFields(r));

  // 2) 清空整表（先删后灌，腾出行数配额；避免旧窗口数据残留）
  const old = await listAllRecordIds(tableId);
  const deleted = await batchDelete(tableId, old);

  // 3) 灌入（最新在前）
  const created = await batchCreate(tableId, records);
  return { deleted, created, total: rows.length };
}

async function main() {
  if (!FEISHU.appToken) {
    console.log("[飞书同步] 未配置 FEISHU_APP_TOKEN，跳过（Postgres 不受影响）。");
    return;
  }
  const days = Number(process.argv[2]) || FEISHU.syncDays;
  const win = windowDates(days);
  console.log(`[飞书同步] 全量替换 · 窗口 ${win.from} ~ ${win.to}（${days} 天）· campaign 粒度=${FEISHU.campaignGrain}`);

  const TABLES = await buildTables(); // 派生表账户/系列从 ad_groups 动态解析
  const ids = await tableIdMap();
  let failed = 0;
  for (const t of TABLES) {
    try {
      const { deleted, created, total } = await syncTable(t, ids, win);
      const warn = created < total ? ` ⚠️ 仅灌 ${created}/${total}（疑似超表上限）` : "";
      console.log(`  ✅ ${t.name}：清 ${deleted} · 灌 ${created}${warn}`);
    } catch (e) {
      failed++;
      console.error(`  ❌ ${t.name}：${e.message}`);
    }
  }
  console.log(`[飞书同步] 完成，${TABLES.length - failed}/${TABLES.length} 张表成功。`);
  if (failed) process.exitCode = 1;
}

main()
  .catch((e) => { console.error("飞书同步失败：", e.message); process.exitCode = 1; })
  .finally(() => end().catch(() => {}));
