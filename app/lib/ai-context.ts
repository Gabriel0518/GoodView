// AI 上下文构建 —— 读看板卡片、跑查询引擎、把结果压成紧凑摘要供 LLM。
// 不把全量行塞进 prompt（365 天会爆）：时序给 总量/均值/首末/极值/趋势；分类给 Top N。
import { withClient } from "./db";
import { runQuery } from "./query-engine";
import { getMeasure } from "./metrics";
import type { QueryFilters, QueryRequest, QueryRow } from "./query-types";

type CardRow = { id: number; title: string; config: QueryRequest & { cardFilters?: Partial<QueryFilters> } };

export type BoardContext = {
  name: string;
  boardFilters: QueryFilters;
  cards: Array<{ title: string; measure: string; unit: string; dims: string[]; note?: string; summary: string; warnings?: string[] }>;
};

// 看板级 + 卡片级筛选合并（board 为底，card 覆盖）——与前端 mergeFilters 同口径。
function mergeFilters(board: QueryFilters, card?: Partial<QueryFilters>): QueryFilters {
  return { ...board, ...(card || {}), granularity: (card?.granularity || board?.granularity || "day") };
}

const fmt = (n: number) => (Math.abs(n) >= 1000 ? Math.round(n).toLocaleString("en-US") : Number(n.toFixed(2)).toString());

// 把查询结果压成一行摘要文本。
function summarizeRows(rows: QueryRow[], dims: string[], unit: string): string {
  if (!rows.length) return "无数据";
  if (dims.length === 0) return `值=${fmt(rows[0].value)}`;
  const dim0 = dims[0];
  const isDate = dim0 === "date";
  const vals = rows.map((r) => r.value);
  const total = vals.reduce((a, b) => a + b, 0);
  const mean = total / vals.length;
  if (isDate && dims.length === 1) {
    const first = rows[0], last = rows[rows.length - 1];
    let maxR = rows[0], minR = rows[0];
    for (const r of rows) { if (r.value > maxR.value) maxR = r; if (r.value < minR.value) minR = r; }
    const chg = first.value ? ((last.value - first.value) / first.value) * 100 : 0;
    return `${rows.length}期(${first.date}~${last.date}) 合计${fmt(total)} 均值${fmt(mean)} 首${fmt(first.value)}→末${fmt(last.value)}(${chg >= 0 ? "+" : ""}${chg.toFixed(0)}%) 峰${maxR.date}=${fmt(maxR.value)} 谷${minR.date}=${fmt(minR.value)}`;
  }
  // 日期 + 序列（如 date×source）：按序列给 首→末 趋势，保留时间维度（否则 Top-8 会丢趋势）。
  if (isDate && dims.length === 2) {
    const sKey = dims[1];
    const bySeries = new Map<string, { first: number; last: number; total: number }>();
    for (const r of rows) {
      const s = String((r as Record<string, unknown>)[sKey] ?? "?");
      const o = bySeries.get(s);
      if (o) { o.last = r.value; o.total += r.value; }        // 行按日期升序，last 持续被更新为最新
      else bySeries.set(s, { first: r.value, last: r.value, total: r.value });
    }
    const parts = [...bySeries.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 6)
      .map(([s, o]) => { const chg = o.first ? ((o.last - o.first) / o.first) * 100 : 0; return `${s}: 合计${fmt(o.total)} 首${fmt(o.first)}→末${fmt(o.last)}(${chg >= 0 ? "+" : ""}${chg.toFixed(0)}%)`; });
    return `按${sKey}(${bySeries.size}序列): ` + parts.join("; ");
  }
  // 分类维度：Top 8
  const top = [...rows].sort((a, b) => b.value - a.value).slice(0, 8);
  const label = (r: QueryRow) => dims.map((d) => (r as Record<string, unknown>)[d]).join("/");
  return `Top ${top.length}/${rows.length}: ` + top.map((r) => `${label(r)}=${fmt(r.value)}`).join(", ");
}

const MAX_CARDS = 24; // 防 prompt 过大：超出只取前 N 张

export async function buildBoardContext(dashboardId: number): Promise<BoardContext | null> {
  const loaded = await withClient(async (c) => {
    const d = await c.query<{ name: string; board_filters: QueryFilters }>(
      `SELECT name, board_filters FROM dashboards WHERE id = $1`,
      [dashboardId],
    );
    if (!d.rows[0]) return null;
    const cards = await c.query<CardRow>(
      `SELECT id, title, config FROM cards WHERE dashboard_id = $1 ORDER BY ord, id`,
      [dashboardId],
    );
    return { name: d.rows[0].name, boardFilters: d.rows[0].board_filters || { granularity: "day" }, cards: cards.rows };
  });
  if (!loaded) return null;

  const out: BoardContext["cards"] = [];
  for (const card of loaded.cards.slice(0, MAX_CARDS)) {
    const cfg = card.config;
    if (!cfg?.measure) continue;
    const m = getMeasure(cfg.measure);
    try {
      const req: QueryRequest = {
        measure: cfg.measure,
        params: cfg.params,
        dims: cfg.dims || [],
        filters: mergeFilters(loaded.boardFilters, cfg.cardFilters),
      };
      const res = await runQuery(req);
      out.push({
        title: card.title || m?.label || cfg.measure,
        measure: cfg.measure,
        unit: res.meta.unit,
        dims: res.meta.dims,
        note: res.meta.note,
        warnings: res.meta.warnings,
        summary: summarizeRows(res.rows, res.meta.dims, res.meta.unit),
      });
    } catch (e) {
      out.push({ title: card.title || cfg.measure, measure: cfg.measure, unit: m?.unit || "", dims: cfg.dims || [], summary: `查询失败：${(e as Error).message}` });
    }
  }
  return { name: loaded.name, boardFilters: loaded.boardFilters, cards: out };
}

// 把上下文渲染成给 LLM 的紧凑文本。
export function contextToText(ctx: BoardContext): string {
  const bf = ctx.boardFilters;
  const src = bf.groupId ? `组#${bf.groupId}` : bf.accounts?.length ? `账户${bf.accounts.length}个` : "全渠道";
  const win = bf.window === "custom" && bf.dateFrom && bf.dateTo ? `${bf.dateFrom}~${bf.dateTo}` : (bf.window || "d30");
  const lines = ctx.cards.map((c, i) =>
    `${i + 1}. 「${c.title}」度量=${c.measure}(${c.unit}) 维度=[${c.dims.join(",") || "无"}]\n   ${c.summary}${c.note ? `\n   口径:${c.note}` : ""}${c.warnings?.length ? `\n   注意:${c.warnings.join(";")}` : ""}`,
  );
  return `看板「${ctx.name}」 数据源=${src} 窗口=${win} 粒度=${bf.granularity || "day"}\n\n卡片数据：\n${lines.join("\n")}`;
}
