"use client";

// 拖拽栅格看板：react-grid-layout 包装。每卡片走 /api/query 渲染，位置变更持久化到 cards.layout。
import { useMemo } from "react";
import GridLayout, { WidthProvider, type Layout } from "react-grid-layout";
import type { Card, BoardFilters, CardLayout } from "./types";
import { mergeFilters } from "./types";
import type { QueryRequest } from "../../lib/query-types";
import { getMeasure } from "../../lib/metrics";
import { useQuery } from "./useQuery";
import { VizRenderer } from "../viz/VizRenderer";

const Grid = WidthProvider(GridLayout);
const COLS = 12;
const ROW_H = 56;

function defaultLayout(i: number): CardLayout {
  return { x: (i % 3) * 4, y: Math.floor(i / 3) * 5, w: 4, h: 5 };
}

export function BoardGrid({
  cards,
  boardFilters,
  onLayoutChange,
  onEditCard,
  onDeleteCard,
}: {
  cards: Card[];
  boardFilters: BoardFilters;
  onLayoutChange: (cardId: number, layout: CardLayout) => void;
  onEditCard: (card: Card) => void;
  onDeleteCard: (card: Card) => void;
}) {
  const layout: Layout[] = useMemo(
    () =>
      cards.map((c, i) => {
        // 新卡片 layout 可能是空对象 {} → 视为无布局，回落到默认位（避免 undefined 坐标）
        const raw = c.layout;
        const l = raw && typeof raw.w === "number" ? raw : defaultLayout(i);
        return { i: String(c.id), x: l.x, y: l.y, w: l.w, h: l.h, minW: 2, minH: 3 };
      }),
    [cards],
  );

  // 拖拽/缩放结束：持久化【全部】位置变了的卡片（RGL 压缩会顺带移动其它卡，只存被拖那张会丢位）。
  const persistAll = (next: Layout[]) => {
    for (const item of next) {
      const id = Number(item.i);
      const cur = cards.find((c) => c.id === id)?.layout;
      if (!cur || cur.x !== item.x || cur.y !== item.y || cur.w !== item.w || cur.h !== item.h) {
        onLayoutChange(id, { x: item.x, y: item.y, w: item.w, h: item.h });
      }
    }
  };

  if (!cards.length) {
    return (
      <div className="rounded-xl border border-dashed border-border px-4 py-16 text-center text-sm text-muted">
        还没有卡片。点击「+ 添加卡片」开始搭建。
      </div>
    );
  }

  return (
    <Grid
      className="layout"
      cols={COLS}
      rowHeight={ROW_H}
      layout={layout}
      margin={[12, 12]}
      draggableHandle=".card-drag"
      isBounded
      onDragStop={(l) => persistAll(l)}
      onResizeStop={(l) => persistAll(l)}
    >
      {cards.map((c) => (
        <div key={String(c.id)}>
          <CardView card={c} boardFilters={boardFilters} onEdit={() => onEditCard(c)} onDelete={() => onDeleteCard(c)} />
        </div>
      ))}
    </Grid>
  );
}

function CardView({
  card,
  boardFilters,
  onEdit,
  onDelete,
}: {
  card: Card;
  boardFilters: BoardFilters;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const cfg = card.config;
  const req: QueryRequest | null = useMemo(() => {
    if (!cfg?.measure || !cfg.viz) return null;
    return {
      measure: cfg.measure,
      params: cfg.params,
      dims: cfg.dims ?? [],
      filters: mergeFilters(boardFilters, cfg.cardFilters),
    };
  }, [cfg, boardFilters]);

  const { rows, meta, loading, error } = useQuery(req);
  const note = getMeasure(cfg?.measure)?.note;

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-sm transition hover:shadow-hover">
      <header className="card-drag flex cursor-move items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <span className="truncate text-xs font-semibold text-strong" title={card.title}>
          {card.title}
        </span>
        <div className="flex shrink-0 items-center gap-1" onMouseDown={(e) => e.stopPropagation()}>
          <button onClick={onEdit} className="rounded px-1.5 py-0.5 text-[11px] text-muted hover:text-body" title="编辑">
            编辑
          </button>
          <button onClick={onDelete} className="rounded px-1.5 py-0.5 text-[11px] text-faint hover:text-danger" title="删除">
            ✕
          </button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <VizRenderer viz={cfg.viz} rows={rows} meta={meta} loading={loading} error={error} note={note} />
      </div>
    </div>
  );
}
