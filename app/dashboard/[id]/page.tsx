"use client";

// 看板视图：看板级筛选条 + 可拖拽/调整大小的卡片栅格 + 添加卡片（CardBuilder）+ AI 解读占位（P3）。
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { Card, CardConfig, CardLayout, BoardFilters, BoardGroup, Dashboard } from "../../components/board/types";
import { DEFAULT_BOARD_FILTERS } from "../../components/board/types";
import {
  listDashboards,
  listGroups,
  listCards,
  createCard,
  updateCard,
  deleteCard,
  updateDashboard,
} from "../../components/board/api";
import { BoardFiltersBar } from "../../components/board/BoardFilters";
import { BoardGrid } from "../../components/board/BoardGrid";
import { CardBuilder } from "../../components/builder/CardBuilder";
import { Panel, Button } from "../../components/ui";

export default function BoardPage({ params }: { params: { id: string } }) {
  const boardId = Number(params.id);

  const [board, setBoard] = useState<Dashboard | null>(null);
  const [filters, setFilters] = useState<BoardFilters>(DEFAULT_BOARD_FILTERS);
  const [groups, setGroups] = useState<BoardGroup[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // 搭建器：null=关闭；{}=新建；{card}=编辑
  const [builder, setBuilder] = useState<{ card?: Card } | null>(null);

  const loadCards = useCallback(async () => {
    const data = await listCards(boardId);
    setCards(Array.isArray(data) ? data : []);
  }, [boardId]);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const [boards, grps] = await Promise.all([listDashboards(), listGroups().catch(() => [])]);
      const b = boards.find((x) => x.id === boardId) ?? null;
      setBoard(b);
      // 始终补齐 window/granularity 默认（旧 board_filters 可能缺 window）
      setFilters({ ...DEFAULT_BOARD_FILTERS, ...(b?.board_filters ?? {}) });
      setGroups(Array.isArray(grps) ? grps : []);
      await loadCards();
    } catch (e) {
      setErr(String((e as Error)?.message || e));
    } finally {
      setLoading(false);
    }
  }, [boardId, loadCards]);

  useEffect(() => {
    load();
  }, [load]);

  // 看板级筛选变更：本地更新 + 持久化（fire-and-forget）
  const onFiltersChange = (next: BoardFilters) => {
    setFilters(next);
    updateDashboard(boardId, { board_filters: next }).catch((e) => setErr(String((e as Error)?.message || e)));
  };

  // 卡片位置变更：乐观更新 + 持久化
  const onLayoutChange = (cardId: number, layout: CardLayout) => {
    setCards((cs) => cs.map((c) => (c.id === cardId ? { ...c, layout } : c)));
    updateCard(boardId, cardId, { layout }).catch((e) => setErr(String((e as Error)?.message || e)));
  };

  const onSaveCard = async (title: string, config: CardConfig) => {
    if (builder?.card) {
      await updateCard(boardId, builder.card.id, { title, config });
    } else {
      // 新卡片追加到最底部，避免与已有布局重叠
      const maxY = cards.reduce((m, c) => Math.max(m, (c.layout?.y ?? 0) + (c.layout?.h ?? 0)), 0);
      await createCard(boardId, title, config, { x: 0, y: maxY, w: 6, h: 5 });
    }
    setBuilder(null);
    await loadCards();
  };

  const onDeleteCard = async (card: Card) => {
    if (!window.confirm(`删除卡片「${card.title}」？`)) return;
    try {
      await deleteCard(boardId, card.id);
      await loadCards();
    } catch (e) {
      setErr(String((e as Error)?.message || e));
    }
  };

  const title = useMemo(() => board?.name ?? `看板 #${boardId}`, [board, boardId]);

  if (!Number.isFinite(boardId)) {
    return <div className="p-6 text-sm text-red-400">无效的看板 ID</div>;
  }

  return (
    <main className="mx-auto max-w-[1400px] space-y-4 px-4 py-5">
      {/* 头部 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Link href="/dashboard" className="text-xs text-zinc-500 hover:text-zinc-200">
            ← 看板列表
          </Link>
          <span className="text-zinc-700">/</span>
          <h1 className="text-lg font-semibold text-zinc-100">{title}</h1>
          {board?.is_template && (
            <span className="rounded bg-accent/20 px-1.5 py-0.5 text-[10px] font-medium text-accent-soft">模板</span>
          )}
        </div>
        <Button variant="primary" onClick={() => setBuilder({})}>
          + 添加卡片
        </Button>
      </div>

      {err && <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-xs text-red-300">{err}</div>}

      {/* 看板级筛选条 */}
      <BoardFiltersBar filters={filters} onChange={onFiltersChange} groups={groups} />

      {/* 栅格 */}
      {loading ? (
        <div className="py-16 text-center text-xs text-zinc-600">加载中…</div>
      ) : (
        <BoardGrid
          cards={cards}
          boardFilters={filters}
          onLayoutChange={onLayoutChange}
          onEditCard={(c) => setBuilder({ card: c })}
          onDeleteCard={onDeleteCard}
        />
      )}

      {/* AI 解读占位（P3） */}
      <Panel title="AI 解读" subtitle="读整个看板数据生成趋势/异常分析（P3）" action={<Button disabled>AI 解读</Button>}>
        <div className="rounded-lg border border-dashed border-ink-700 px-4 py-8 text-center text-xs text-zinc-600">
          搭好看板后，这里可一键生成 AI 解读与卡片推荐（即将上线）。
        </div>
      </Panel>

      {/* 搭建器弹层 */}
      {builder && (
        <CardBuilder
          boardFilters={filters}
          initial={builder.card ? { title: builder.card.title, config: builder.card.config } : undefined}
          onSave={onSaveCard}
          onCancel={() => setBuilder(null)}
        />
      )}
    </main>
  );
}
