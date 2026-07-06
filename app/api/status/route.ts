import { NextResponse } from "next/server";
import { getStatus } from "../../lib/db-queries";

export const dynamic = "force-dynamic";

// 前端轮询：发现 generated_at(=数据 updated_at) 变化即提示加载最新
export async function GET() {
  try {
    const s = await getStatus();
    return NextResponse.json(s);
  } catch (e: unknown) {
    return NextResponse.json(
      { snapshot_generated_at: null, funnel_generated_at: null, pull: null, error: String((e as Error)?.message || e) },
      { status: 500 },
    );
  }
}
