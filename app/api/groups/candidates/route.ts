import { NextResponse } from "next/server";
import { listCandidates } from "../../../lib/groups";

export const dynamic = "force-dynamic";

// 候选账户/系列 + 花费（组管理页勾选用）
export async function GET() {
  try {
    return NextResponse.json(await listCandidates());
  } catch (e: unknown) {
    return NextResponse.json({ accounts: [], campaigns: [], error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
