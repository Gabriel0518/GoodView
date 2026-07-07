"use client";

// v3 看板弹窗：点桌面看板卡片打开。内含 看板筛选条 + 数据卡片栅格 + AI 解读 + 卡片搭建器。
// 逻辑与旧 /dashboard/[id] 一致，仅换成模态外壳；关闭时回调父级（清 URL + 刷新卡片数）。
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

import { useCallback, useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import type { Card, CardConfig, CardLayout, BoardFilters, BoardGroup, Dashboard } from "./types";
import { DEFAULT_BOARD_FILTERS } from "./types";
import { listDashboards, listGroups, listCards, createCard, updateCard, deleteCard, updateDashboard } from "./api";
import { BoardFiltersBar } from "./BoardFilters";
import { BoardGrid } from "./BoardGrid";
import { AiInsightPanel } from "./AiInsightPanel";
import { CardBuilder } from "../builder/CardBuilder";
import { Button } from "../ui";

export function BoardModal({ boardId, onClose }: { boardId: number; onClose: () => void }) {
  const [board, setBoard] = useState<Dashboard | null>(null);
  const [filters, setFilters] = useState<BoardFilters>(DEFAULT_BOARD_FILTERS);
  const [groups, setGroups] = useState<BoardGroup[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
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
      const b = boards.find((x) => Number(x.id) === boardId) ?? null;  // pg bigint id 是字符串，转数字比
      setBoard(b);
      setFilters({ ...DEFAULT_BOARD_FILTERS, ...(b?.board_filters ?? {}) });
      setGroups(Array.isArray(grps) ? grps : []);
      await loadCards();
    } catch (e) {
      setErr(String((e as Error)?.message || e));
    } finally {
      setLoading(false);
    }
  }, [boardId, loadCards]);

  useEffect(() => { load(); }, [load]);

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !builder) onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, builder]);

  const onFiltersChange = (next: BoardFilters) => {
    setFilters(next);
    updateDashboard(boardId, { board_filters: next }).catch((e) => setErr(String((e as Error)?.message || e)));
  };

  const onLayoutChange = (cardId: number, layout: CardLayout) => {
    setCards((cs) => cs.map((c) => (c.id === cardId ? { ...c, layout } : c)));
    updateCard(boardId, cardId, { layout }).catch((e) => setErr(String((e as Error)?.message || e)));
  };

  const onSaveCard = async (title: string, config: CardConfig) => {
    if (builder?.card) {
      await updateCard(boardId, builder.card.id, { title, config });
    } else {
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

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-strong/40 p-3 sm:p-6" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="mx-auto flex h-full w-full max-w-[1400px] flex-col overflow-hidden rounded-2xl border border-border bg-canvas shadow-md">
        {/* 头部 */}
        <header className="flex items-center justify-between gap-3 border-b border-border bg-surface px-5 py-3">
          <div className="flex items-center gap-2">
            <h1 className="text-[15px] font-semibold text-strong">{title}</h1>
            {board?.is_template && <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-medium text-accent">模板</span>}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="primary" onClick={() => setBuilder({})}>+ 添加卡片</Button>
            <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-subtle hover:text-body" title="关闭 (Esc)"><X size={18} /></button>
          </div>
        </header>

        {/* 内容 */}
        <div className="flex-1 space-y-4 overflow-auto p-5">
          {err && <div className="rounded-xl border border-danger/30 bg-danger-soft px-4 py-3 text-xs text-danger">{err}</div>}
          <BoardFiltersBar filters={filters} onChange={onFiltersChange} groups={groups} />
          {loading ? (
            <div className="py-16 text-center text-xs text-muted">加载中…</div>
          ) : (
            <BoardGrid cards={cards} boardFilters={filters} onLayoutChange={onLayoutChange} onEditCard={(c) => setBuilder({ card: c })} onDeleteCard={onDeleteCard} />
          )}
          <AiInsightPanel dashboardId={boardId} onAddCard={onSaveCard} />
        </div>
      </div>

      {builder && (
        <CardBuilder
          boardFilters={filters}
          initial={builder.card ? { title: builder.card.title, config: builder.card.config } : undefined}
          onSave={onSaveCard}
          onCancel={() => setBuilder(null)}
        />
      )}
    </div>
  );
}
