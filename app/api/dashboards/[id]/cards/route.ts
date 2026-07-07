import { NextResponse } from "next/server";
import { q } from "../../../../lib/db";

export const dynamic = "force-dynamic";

// GET /api/dashboards/[id]/cards —— 某看板的全部卡片
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    const r = await q(
      `SELECT id, dashboard_id, title, config, layout, ord
       FROM cards WHERE dashboard_id = $1 ORDER BY ord, id`,
      [params.id],
    );
    return NextResponse.json(r.rows);
  } catch (e: unknown) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}

// POST /api/dashboards/[id]/cards —— 新增卡片 { title?, config, layout?, ord? } → { id }
export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const { title, config, layout, ord } = await req.json();
    if (!config) return NextResponse.json({ error: "config 必填" }, { status: 400 });
    const r = await q(
      `INSERT INTO cards (dashboard_id, title, config, layout, ord)
       VALUES ($1,$2,$3::jsonb,$4::jsonb,$5) RETURNING id`,
      [params.id, title || "", JSON.stringify(config), JSON.stringify(layout || {}), ord ?? 0],
    );
    return NextResponse.json({ id: (r.rows[0] as { id: number }).id });
  } catch (e: unknown) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}

// PUT /api/dashboards/[id]/cards —— 更新卡片 { id, title?, config?, layout?, ord? }
export async function PUT(req: Request) {
  try {
    const { id, title, config, layout, ord } = await req.json();
    if (!id) return NextResponse.json({ error: "id 必填" }, { status: 400 });
    await q(
      `UPDATE cards SET
         title = COALESCE($2, title),
         config = COALESCE($3::jsonb, config),
         layout = COALESCE($4::jsonb, layout),
         ord = COALESCE($5, ord),
         updated_at = now()
       WHERE id = $1`,
      [id, title ?? null, config ? JSON.stringify(config) : null, layout ? JSON.stringify(layout) : null, ord ?? null],
    );
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}

// DELETE /api/dashboards/[id]/cards?cardId= —— 删除卡片
export async function DELETE(req: Request) {
  try {
    const cardId = new URL(req.url).searchParams.get("cardId");
    if (!cardId) return NextResponse.json({ error: "cardId 必填" }, { status: 400 });
    await q(`DELETE FROM cards WHERE id = $1`, [cardId]);
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
