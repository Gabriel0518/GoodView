// 并行拉取：同时跑 fetch-snapshot(XMP) 和 fetch-funnel(BytePlus)，两者互不依赖。
// 记录到 pull_runs 表（前端 /api/status 读最新一条）。
// 用法：node pull-all.mjs [天数]
import { spawn } from "node:child_process";
import { query, end } from "./lib/db.mjs";
import { SETTINGS, FEISHU } from "./config.mjs";

function run(cmd, args, env) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: "inherit", env: env ? { ...process.env, ...env } : process.env });
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

  // 抓取前先把飞书「XMP抓取配置」同步进 DB（失败不阻断：fetch-snapshot 用 DB 上次配置兜底）。
  if (FEISHU.appToken) {
    const cfgCode = await run("node", ["sync-config-from-feishu.mjs"]);
    if (cfgCode !== 0) console.warn(`  ⚠️ 配置同步返回 ${cfgCode}（用 DB 上次配置继续）`);
  }

  // XMP 花费/素材含当天（INCLUDE_TODAY）：实时镜像表/汇总「今日」行需要当天花费。
  // 优化表(daily-adgroup-report)已把目标日夹到「昨天」，不受含当天影响。
  const [snapCode, funnelCode] = await Promise.all([
    run("node", ["fetch-snapshot.mjs", ...daysArg], { INCLUDE_TODAY: "1" }),
    run("node", ["fetch-funnel.mjs", ...daysArg]),  // funnel 已默认含当天
  ]);

  // 留存快照（BytePlus sitin 看板报表）——独立、失败不影响主库；写 retention_summary。
  const retCode = await run("node", ["fetch-retention.mjs"]);
  if (retCode !== 0) console.warn(`  ⚠️ 留存拉取返回 ${retCode}（不影响主流程）`);

  // 素材(ad)级抓取（仅活跃 PWA 账户，account_id 过滤，轻量）——写 ad_daily，供广告组日报算「可加量素材」。
  // 在 snapshot 之后跑，避开 XMP QPM 争抢；失败不影响主库/退出码。
  const adsCode = await run("node", ["fetch-ads.mjs"], { INCLUDE_TODAY: "1" });
  if (adsCode !== 0) console.warn(`  ⚠️ 素材级拉取返回 ${adsCode}（不影响主流程）`);

  // AI公会分端(安卓/iOS)转化——写 aiguild_os_daily，供「AI公会分端汇总」。失败不影响主库/退出码。
  const aiOsCode = await run("node", ["fetch-aiguild-os.mjs"]);
  if (aiOsCode !== 0) console.warn(`  ⚠️ AI公会分端拉取返回 ${aiOsCode}（不影响主流程）`);

  // 自有后台业务库(DMS)：IG绑定/成材 的真实业务记录，写 dms_metric_daily，供「关键指标日报」全量行。
  // 未配 DMS_TOKEN 时脚本自己跳过；失败不影响主库/退出码（看板回退 BytePlus 口径）。
  const dmsCode = await run("node", ["fetch-dms.mjs", ...daysArg]);
  if (dmsCode !== 0) console.warn(`  ⚠️ 业务库拉取返回 ${dmsCode}（不影响主流程，看板回退 BytePlus）`);

  // 关键指标 × 地区(德州/非德州/全量)——写 key_metric_daily，供「关键指标日报」。
  // 官方关键指标口径（lib/key-metrics.mjs），与 funnel 各存一份，失败不影响主库/退出码。
  const kmCode = await run("node", ["fetch-key-metrics.mjs", ...daysArg]);
  if (kmCode !== 0) console.warn(`  ⚠️ 关键指标拉取返回 ${kmCode}（不影响主流程）`);

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
