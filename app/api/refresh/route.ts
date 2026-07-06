import { NextResponse } from "next/server";
import { spawn } from "node:child_process";

export const dynamic = "force-dynamic";

// 手动触发一次拉取：后台跑 pull-all.mjs（写库），立即返回。
// 拉取 2-3 分钟，不阻塞 HTTP 请求；前端靠 /api/status 轮询检测完成。
export async function POST() {
  try {
    const child = spawn("node", ["pull-all.mjs"], {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
    return NextResponse.json({ ok: true, started: true });
  } catch (e: unknown) {
    return NextResponse.json({ ok: false, error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
