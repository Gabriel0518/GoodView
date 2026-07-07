import { NextResponse } from "next/server";
import { q } from "../../lib/db";

export const dynamic = "force-dynamic";

// 事件配置（漏斗阶段）CRUD —— 写 funnel_stage_meta，下次 cron 拉取按新定义取数。

// GET /api/events —— 全部阶段（按 ord）
export async function GET() {
  try {
    const r = await q(
      `SELECT stage_key, ord, label, event_name, filters, enabled, source_split, indicator, status, updated_at
       FROM funnel_stage_meta ORDER BY ord, stage_key`,
    );
    return NextResponse.json(r.rows);
  } catch (e: unknown) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}

// POST /api/events —— 新增事件 { stage_key, label, event_name, ord?, filters?, enabled?, source_split?, indicator? }
export async function POST(req: Request) {
  try {
    const b = await req.json();
    if (!b?.stage_key || !b?.label || !b?.event_name) {
      return NextResponse.json({ error: "stage_key / label / event_name 必填" }, { status: 400 });
    }
    // ord 缺省放到末尾
    const ord = b.ord ?? null;
    await q(
      `INSERT INTO funnel_stage_meta (stage_key, ord, label, event_name, filters, enabled, source_split, indicator, updated_at)
       VALUES ($1, COALESCE($2, (SELECT COALESCE(MAX(ord),-1)+1 FROM funnel_stage_meta)), $3, $4, $5::jsonb, $6, $7, $8, now())`,
      [b.stage_key, ord, b.label, b.event_name, b.filters ? JSON.stringify(b.filters) : null,
       b.enabled ?? true, b.source_split ?? true, b.indicator ?? "event_users"],
    );
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const msg = String((e as Error)?.message || e);
    if (/duplicate key|unique constraint/i.test(msg)) {
      return NextResponse.json({ error: "stage_key 已存在，请换一个" }, { status: 409 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// PUT /api/events —— 更新事件 { stage_key, label?, event_name?, ord?, filters?, enabled?, source_split?, indicator? }
export async function PUT(req: Request) {
  try {
    const b = await req.json();
    if (!b?.stage_key) return NextResponse.json({ error: "stage_key 必填" }, { status: 400 });
    await q(
      `UPDATE funnel_stage_meta SET
         label = COALESCE($2, label),
         event_name = COALESCE($3, event_name),
         ord = COALESCE($4, ord),
         filters = CASE WHEN $5::text IS NULL THEN filters ELSE $5::jsonb END,
         enabled = COALESCE($6, enabled),
         source_split = COALESCE($7, source_split),
         indicator = COALESCE($8, indicator),
         updated_at = now()
       WHERE stage_key = $1`,
      [b.stage_key, b.label ?? null, b.event_name ?? null, b.ord ?? null,
       b.filters === undefined ? null : JSON.stringify(b.filters),
       b.enabled ?? null, b.source_split ?? null, b.indicator ?? null],
    );
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}

// DELETE /api/events?stage_key= —— 删除事件（funnel_daily 行级联删除）
export async function DELETE(req: Request) {
  try {
    const key = new URL(req.url).searchParams.get("stage_key");
    if (!key) return NextResponse.json({ error: "stage_key 必填" }, { status: 400 });
    await q(`DELETE FROM funnel_stage_meta WHERE stage_key = $1`, [key]);
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
