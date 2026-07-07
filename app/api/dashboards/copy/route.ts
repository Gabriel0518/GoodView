import { NextResponse } from "next/server";
import { withClient } from "../../../lib/db";

export const dynamic = "force-dynamic";

// POST /api/dashboards/copy —— 复制看板（含全部卡片）。body { id, name? } → { id }
export async function POST(req: Request) {
  try {
    const { id, name } = await req.json();
    if (!id) return NextResponse.json({ error: "id 必填" }, { status: 400 });
    const newId = await withClient(async (c) => {
      const src = await c.query<{ name: string; board_filters: unknown }>(
        `SELECT name, board_filters FROM dashboards WHERE id = $1`,
        [id],
      );
      if (!src.rows[0]) throw new Error("看板不存在");
      const copyName = name || `${src.rows[0].name} 副本`;
      const ins = await c.query<{ id: number }>(
        `INSERT INTO dashboards (name, board_filters, is_template)
         VALUES ($1, $2::jsonb, false) RETURNING id`,
        [copyName, JSON.stringify(src.rows[0].board_filters ?? {})],
      );
      const newDashId = ins.rows[0].id;
      // 复制卡片
      await c.query(
        `INSERT INTO cards (dashboard_id, title, config, layout, ord)
         SELECT $1, title, config, layout, ord FROM cards WHERE dashboard_id = $2`,
        [newDashId, id],
      );
      return newDashId;
    });
    return NextResponse.json({ id: newId });
  } catch (e: unknown) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
