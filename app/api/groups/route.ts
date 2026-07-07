import { NextResponse } from "next/server";
import { q } from "../../lib/db";

export const dynamic = "force-dynamic";

// 组列表
export async function GET() {
  try {
    const r = await q(`SELECT id, name, members, is_app_group FROM ad_groups ORDER BY created_at`);
    return NextResponse.json(r.rows);
  } catch (e: unknown) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}

// 新建组
export async function POST(req: Request) {
  try {
    const { name, members, is_app_group } = await req.json();
    if (!name) return NextResponse.json({ error: "name 必填" }, { status: 400 });
    const r = await q(
      `INSERT INTO ad_groups (name, members, is_app_group) VALUES ($1,$2::jsonb,$3) RETURNING id`,
      [name, JSON.stringify(members || []), !!is_app_group],
    );
    return NextResponse.json({ id: (r.rows[0] as { id: number }).id });
  } catch (e: unknown) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}

// 更新组
export async function PUT(req: Request) {
  try {
    const { id, name, members, is_app_group } = await req.json();
    if (!id) return NextResponse.json({ error: "id 必填" }, { status: 400 });
    await q(
      `UPDATE ad_groups SET name=$2, members=$3::jsonb, is_app_group=$4, updated_at=now() WHERE id=$1`,
      [id, name, JSON.stringify(members || []), !!is_app_group],
    );
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}

// 删除组
export async function DELETE(req: Request) {
  try {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id 必填" }, { status: 400 });
    await q(`DELETE FROM ad_groups WHERE id=$1`, [id]);
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
