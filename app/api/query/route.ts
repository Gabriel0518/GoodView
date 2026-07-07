import { NextResponse } from "next/server";
import { runQuery } from "../../lib/query-engine";
import type { QueryRequest } from "../../lib/query-types";

export const dynamic = "force-dynamic";

// POST /api/query —— 透视查询。body = QueryRequest → QueryResponse。
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as QueryRequest;
    if (!body?.measure) return NextResponse.json({ error: "measure 必填" }, { status: 400 });
    const out = await runQuery(body);
    return NextResponse.json(out);
  } catch (e: unknown) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 400 });
  }
}
