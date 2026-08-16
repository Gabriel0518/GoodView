// Postgres → 飞书多维表格 单向同步。Postgres 为权威库；飞书是给仪表盘用的镜像。
//
// 策略（2026-07-31 起改为**增量窗口更新**，此前是全量替换）：
//   · 窗口表(windowed=true)：只删飞书里 date_num 落在 [from,to] 的行、再灌入同窗口的新数据。
//     **窗口外的历史行原样保留** → 飞书表逐日累积，比 Postgres 的抓取窗口(30 天)看得更长。
//     幂等：同一窗口重复同步 = 删掉再灌回同一批，结果一致。
//   · 配置表(windowed=false)：无日期维度、快照语义（阶段定义/分组/留存汇总）→ 仍全量替换。
//
// ⚠️ 飞书单表 2 万行硬限（本 tenant）。增量累积迟早顶到，故加容量守卫：灌入前估算
//   现存行数 − 本窗口将删除数 + 本次要灌入数，超过 FEISHU.maxRows(默认 19000) 就按 date_num
//   升序裁掉最旧的行腾地方，并打日志说明裁了多少。这是被平台上限逼出来的，不是业务上想删历史；
//   要多留历史就调高 FEISHU_MAX_ROWS(≤20000)，或降低该表的行密度。
//
// 单个表失败不影响其它表；有任一失败则退出码非 0（cron 里 pull-all 已完成，主库不受影响）。
// 用法：node sync-to-feishu.mjs [天数] [--table=表名]
//   一次性回补历史：node sync-to-feishu.mjs 90 → 把近 90 天灌进飞书（受 2 万行上限约束）。
//   只推一张表：node sync-to-feishu.mjs --table=小美投放转化 → 给独立 cron 用，不去动其它 33 张表
//   （全量同步要几分钟，日更单表的定时任务没必要每次把整个 Base 重推一遍）。
import { query, end } from "./lib/db.mjs";
import {
  tableIdMap, batchCreate, batchDelete, listAllRecordIds,
  searchRecordIdsByDateNum, countRecords, oldestRecordIds, dateNum,
} from "./lib/feishu.mjs";
import { buildTables, DATE_NUM_FIELD } from "./feishu-tables.mjs";
import { FEISHU } from "./config.mjs";

function windowDates(days) {
  // 上海时区「今天」为窗口结束日（含当天进行中数据；BytePlus/XMP 均已支持拉当天）。
  const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date()); // YYYY-MM-DD
  const endD = new Date(todayStr + "T00:00:00Z");
  const startD = new Date(endD); startD.setUTCDate(startD.getUTCDate() - (days - 1));
  const ymd = (d) => d.toISOString().slice(0, 10);
  return { from: ymd(startD), to: ymd(endD) };
}

async function syncTable(t, ids, win) {
  const tableId = ids[t.name];
  if (!tableId) throw new Error(`飞书里找不到表「${t.name}」，请先 node feishu-init-tables.mjs`);

  // 1) 读 Postgres（窗口表=近 N 天倒序；配置表=全部）
  const { text, params } = t.sql(win.from, win.to);
  const { rows } = await query(text, params);
  const records = rows.map((r) => t.toFields(r));

  // 2) 无日期维度的表 → 全量替换。两类：
  //    · 配置表(windowed=false)：阶段定义/分组/留存汇总，快照语义。
  //    · 汇总表(windowed=true 但没有 date_num)：AI公会汇总/分端汇总/PWA渠道汇总——它们是把整个
  //      窗口聚合成几行「近7天/近30天」口径，行本身不带日期，累积就会变成重复行。
  //    靠「有没有 date_num 字段」自动判定，新增汇总表不用改这里。
  const incremental = t.windowed && t.fields.some((f) => f.field_name === DATE_NUM_FIELD);
  if (!incremental) {
    const deleted = await batchDelete(tableId, await listAllRecordIds(tableId));
    const created = await batchCreate(tableId, records);
    return { mode: t.windowed ? "全量替换(汇总)" : "全量替换", deleted, created, total: rows.length, trimmed: 0 };
  }

  // 3) 明细表：只删本窗口的行，窗口外历史保留
  const fromNum = dateNum(win.from), toNum = dateNum(win.to);
  const before = await countRecords(tableId);
  const stale = await searchRecordIdsByDateNum(tableId, DATE_NUM_FIELD, fromNum, toNum);
  const deleted = await batchDelete(tableId, stale);

  // 4) 容量守卫：删完窗口后剩多少 + 这次要灌多少 > 上限 → 裁最旧的腾地方
  let trimmed = 0;
  const projected = before - deleted + records.length;
  if (projected > FEISHU.maxRows) {
    trimmed = await batchDelete(tableId, await oldestRecordIds(tableId, DATE_NUM_FIELD, projected - FEISHU.maxRows));
  }

  const created = await batchCreate(tableId, records);
  return { mode: "窗口更新", deleted, created, total: rows.length, trimmed, after: before - deleted - trimmed + created };
}

async function main() {
  if (!FEISHU.appToken) {
    console.log("[飞书同步] 未配置 FEISHU_APP_TOKEN，跳过（Postgres 不受影响）。");
    return;
  }
  const args = process.argv.slice(2);
  const only = (args.find((a) => a.startsWith("--table=")) || "").slice("--table=".length);
  const days = Number(args.find((a) => !a.startsWith("--"))) || FEISHU.syncDays;
  const win = windowDates(days);
  console.log(`[飞书同步] 增量窗口更新 · 窗口 ${win.from} ~ ${win.to}（${days} 天，窗口外历史保留）· 单表上限 ${FEISHU.maxRows} · campaign 粒度=${FEISHU.campaignGrain}${only ? ` · 仅推「${only}」` : ""}`);

  let TABLES = await buildTables(); // 派生表账户/系列从 ad_groups 动态解析
  if (only) {
    TABLES = TABLES.filter((t) => t.name === only);
    if (!TABLES.length) throw new Error(`--table=${only} 没匹配到任何表定义（名字写错了？见 feishu-tables.mjs）`);
  }
  const ids = await tableIdMap();
  let failed = 0;
  const trimmedTables = [];
  for (const t of TABLES) {
    try {
      const r = await syncTable(t, ids, win);
      const warn = r.created < r.total ? ` ⚠️ 仅灌 ${r.created}/${r.total}（疑似超表上限）` : "";
      const trim = r.trimmed ? ` · ⚠️ 裁最旧 ${r.trimmed} 行（顶到 ${FEISHU.maxRows} 上限）` : "";
      const tail = r.mode === "窗口更新" ? ` · 表内共 ${r.after}` : "";
      console.log(`  ✅ ${t.name}（${r.mode}）：删窗口 ${r.deleted} · 灌 ${r.created}${tail}${trim}${warn}`);
      if (r.trimmed) trimmedTables.push(t.name);
    } catch (e) {
      failed++;
      console.error(`  ❌ ${t.name}：${e.message}`);
    }
  }
  console.log(`[飞书同步] 完成，${TABLES.length - failed}/${TABLES.length} 张表成功。`);
  if (trimmedTables.length) {
    console.log(`⚠️ 已达行数上限、被裁掉最旧数据的表：${trimmedTables.join("、")}`);
    console.log(`   要多留历史：调高 FEISHU_MAX_ROWS（≤20000），或降低这些表的行密度。`);
  }
  if (failed) process.exitCode = 1;
}

main()
  .catch((e) => { console.error("飞书同步失败：", e.message); process.exitCode = 1; })
  .finally(() => end().catch(() => {}));
