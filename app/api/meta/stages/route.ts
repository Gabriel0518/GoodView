import { NextResponse } from "next/server";
import { q } from "../../../lib/db";

export const dynamic = "force-dynamic";

// GET /api/meta/stages —— 漏斗阶段目录（供搭建器的阶段选择器：people/unit_cost/cvr）。
// 只返回启用的阶段，按 ord 排序。
export async function GET() {
  try {
    const r = await q<{ stage_key: string; label: string; ord: number }>(
      `SELECT stage_key, label, ord FROM funnel_stage_meta WHERE enabled = true ORDER BY ord`,
    );
    return NextResponse.json(r.rows);
  } catch (e: unknown) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
