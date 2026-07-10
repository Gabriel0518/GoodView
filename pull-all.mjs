// 并行拉取：同时跑 fetch-snapshot(XMP) 和 fetch-funnel(BytePlus)，两者互不依赖。
// 记录到 pull_runs 表（前端 /api/status 读最新一条）。
// 用法：node pull-all.mjs [天数]
import { spawn } from "node:child_process";
import { query, end } from "./lib/db.mjs";
import { SETTINGS, FEISHU } from "./config.mjs";

function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: "inherit" });
    p.on("close", (code) => resolve(code ?? 1));
    p.on("error", () => resolve(1));
  });
}

function windowDates(days) {
  const ymd = (d) => d.toISOString().slice(0, 10);
  const today = new Date();
  const end_ = new Date(today); end_.setDate(end_.getDate() - 1);
  const start = new Date(today); start.setDate(start.getDate() - days);
  return { start: ymd(start), end: ymd(end_) };
}

async function main() {
  const t0 = Date.now();
  const days = Number(process.argv[2]) || SETTINGS.defaultLookbackDays;
  const daysArg = process.argv[2] ? [process.argv[2]] : [];
  const { start, end: endDate } = windowDates(days);

  // 开一条 pull_runs
  const { rows } = await query(
    "INSERT INTO pull_runs (started_at, days, start_date, end_date) VALUES (now(), $1, $2, $3) RETURNING id",
    [days, start, endDate],
  );
  const runId = rows[0].id;
  console.log(`[${new Date().toISOString()}] pull #${runId} 并行拉取 snapshot + funnel（${days} 天）…`);

  const [snapCode, funnelCode] = await Promise.all([
    run("node", ["fetch-snapshot.mjs", ...daysArg]),
    run("node", ["fetch-funnel.mjs", ...daysArg]),
  ]);

  // 留存快照（BytePlus sitin 看板报表）——独立、失败不影响主库；写 retention_summary。
  const retCode = await run("node", ["fetch-retention.mjs"]);
  if (retCode !== 0) console.warn(`  ⚠️ 留存拉取返回 ${retCode}（不影响主流程）`);

  const ok = snapCode === 0 && funnelCode === 0;
  await query(
    "UPDATE pull_runs SET finished_at = now(), ok = $2, snapshot_ok = $3, funnel_ok = $4 WHERE id = $1",
    [runId, ok, snapCode === 0, funnelCode === 0],
  );

  // 拉库完成后镜像到飞书多维表格（Postgres 为准）。仅在配置了飞书时执行；失败不影响主库/退出码。
  if (FEISHU.appToken) {
    console.log(`[${new Date().toISOString()}] pull #${runId} → 同步飞书多维表格…`);
    const syncCode = await run("node", ["sync-to-feishu.mjs"]);
    if (syncCode !== 0) console.warn(`  ⚠️ 飞书同步返回 ${syncCode}（不影响 Postgres）`);
  }

  const dur = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[${new Date().toISOString()}] pull #${runId} ${ok ? "完成 ✅" : "部分失败 ⚠️"} 耗时 ${dur}s（snapshot=${snapCode} funnel=${funnelCode}）`);
  await end();
  process.exit(ok ? 0 : 1);
}

main().catch(async (e) => {
  console.error("pull-all 失败：", e.message);
  await end().catch(() => {});
  process.exit(1);
});
