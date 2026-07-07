import { NextResponse } from "next/server";
import { q } from "../../lib/db";

export const dynamic = "force-dynamic";

// GET /api/dashboards —— 看板列表
export async function GET() {
  try {
    const r = await q(
      `SELECT d.id, d.name, d.board_filters, d.canvas, d.is_template, d.created_at, d.updated_at,
              (SELECT COUNT(*)::int FROM cards WHERE dashboard_id = d.id) AS card_count
       FROM dashboards d ORDER BY d.is_template, d.created_at`,
    );
    return NextResponse.json(r.rows);
  } catch (e: unknown) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}

// POST /api/dashboards —— 新建看板 { name, board_filters?, canvas?, is_template? }
export async function POST(req: Request) {
  try {
    const { name, board_filters, canvas, is_template } = await req.json();
    if (!name) return NextResponse.json({ error: "name 必填" }, { status: 400 });
    const r = await q(
      `INSERT INTO dashboards (name, board_filters, canvas, is_template) VALUES ($1,$2::jsonb,$3::jsonb,$4) RETURNING id`,
      [name, JSON.stringify(board_filters || {}), JSON.stringify(canvas || {}), !!is_template],
    );
    return NextResponse.json({ id: (r.rows[0] as { id: number }).id });
  } catch (e: unknown) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}

// PUT /api/dashboards —— 更新看板 { id, name?, board_filters?, canvas?, is_template? }
export async function PUT(req: Request) {
  try {
    const { id, name, board_filters, canvas, is_template } = await req.json();
    if (!id) return NextResponse.json({ error: "id 必填" }, { status: 400 });
    await q(
      `UPDATE dashboards SET
         name = COALESCE($2, name),
         board_filters = COALESCE($3::jsonb, board_filters),
         canvas = COALESCE($4::jsonb, canvas),
         is_template = COALESCE($5, is_template),
         updated_at = now()
       WHERE id = $1`,
      [id, name ?? null, board_filters ? JSON.stringify(board_filters) : null,
       canvas ? JSON.stringify(canvas) : null, is_template ?? null],
    );
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}

// DELETE /api/dashboards?id= —— 删除看板（cards 级联删除）
export async function DELETE(req: Request) {
  try {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id 必填" }, { status: 400 });
    await q(`DELETE FROM dashboards WHERE id = $1`, [id]);
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
