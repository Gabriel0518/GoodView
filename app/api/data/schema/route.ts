import { NextResponse } from "next/server";
import { checkAuth, getSchema, CAVEATS } from "../../../lib/data-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/data/schema —— 全部表的字段/类型/约行数 + 每张表的口径说明。
// 外部 AI 写 SQL 前应该先调这个。
export async function GET(req: Request) {
  const auth = checkAuth(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    const tables = await getSchema();
    return NextResponse.json({ tables, important_caveats: CAVEATS });
  } catch (e: unknown) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
