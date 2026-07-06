// 后台定时拉取守护进程：每 N 分钟自动拉一次数据，写 data/*.json。
// 前端(force-dynamic)每次请求读文件，因此用户无需手动拉取，页面 reload 即见最新。
//
// 本地/单机用法：
//   PULL_INTERVAL_MIN=5 node daemon.mjs        # 每 5 分钟拉一次（默认 5）
//   （建议用 pm2 常驻：pm2 start daemon.mjs）
//
// 上线部署（推荐）：
//   用 cron 每 5 分钟调 `node pull-all.mjs`，把 data/*.json 换成写数据库；
//   前端 API 改为读数据库。可再加「增量拉取」（每次只拉最近 3 天，减少 XMP 请求）。
import { spawn } from "node:child_process";

const INTERVAL_MIN = Number(process.env.PULL_INTERVAL_MIN || 5);
const DAYS = process.env.PULL_DAYS || "";
let running = false;

function pull() {
  if (running) {
    console.log(`[${new Date().toISOString()}] 上一轮尚未完成，跳过本轮`);
    return;
  }
  running = true;
  const t0 = Date.now();
  const args = ["pull-all.mjs", ...(DAYS ? [DAYS] : [])];
  const p = spawn("node", args, { stdio: "inherit" });
  p.on("close", (code) => {
    running = false;
    console.log(`[${new Date().toISOString()}] 本轮结束 code=${code} 耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s，${INTERVAL_MIN} 分钟后再拉\n`);
  });
  p.on("error", (e) => { running = false; console.error("拉取进程启动失败：", e.message); });
}

console.log(`后台定时拉取已启动：每 ${INTERVAL_MIN} 分钟一次${DAYS ? `（${DAYS} 天）` : ""}。Ctrl+C 停止。\n`);
pull(); // 启动立即拉一次
setInterval(pull, INTERVAL_MIN * 60 * 1000);
