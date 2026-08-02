import { NextResponse } from "next/server";
import { checkAuth, validateSql, runReadOnly, DEFAULT_LIMIT } from "../../../lib/data-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/data/query —— 执行只读 SQL。
// body: { sql: string, limit?: number }
//
// 三层防护，安全边界是第 2 层（前后两层只是「早失败」和「纵深防御」）：
//   1) validateSql：拒绝多语句 / 非 SELECT 开头 —— 只为给出清晰报错，不承担安全职责
//   2) READ ONLY 事务：Postgres 内核拒绝一切写入与 DDL，与 SQL 文本长什么样无关 ← 真正的边界
//   3) 可选的专用只读角色（DATA_API_DATABASE_URL）：连权限都没有
export async function POST(req: Request) {
  const auth = checkAuth(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: { sql?: string; limit?: number };
  try {
    body = (await req.json()) as { sql?: string; limit?: number };
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON，期望 {\"sql\": \"...\"}" }, { status: 400 });
  }

  const sql = String(body?.sql || "");
  const bad = validateSql(sql);
  if (bad) return NextResponse.json({ error: bad }, { status: 400 });

  try {
    const out = await runReadOnly(sql, Number(body?.limit) || DEFAULT_LIMIT);
    return NextResponse.json({ ok: true, ...out });
  } catch (e: unknown) {
    const msg = String((e as Error)?.message || e);
    // 超时和只读违规是「用户 SQL 的问题」，回 400 让调用方自己改；其余按 500
    const isUserErr = /read-only transaction|statement timeout|syntax error|does not exist|permission denied/i.test(msg);
    return NextResponse.json({ ok: false, error: msg }, { status: isUserErr ? 400 : 500 });
  }
}
