"use client";

// 看板视图：看板级筛选条 + 可拖拽/调整大小的卡片栅格 + 添加卡片（CardBuilder）+ AI 解读占位（P3）。
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { Card, CardConfig, CardLayout, BoardFilters, BoardGroup, Dashboard } from "../../components/board/types";
import type { DimKey, VizType } from "../../lib/metrics";
import type { QueryParams } from "../../lib/query-types";
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
    return <div className="p-6 text-sm text-danger">无效的看板 ID</div>;
  }

  return (
    <main className="mx-auto max-w-[1400px] space-y-4 px-4 py-5">
      {/* 头部 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Link href="/dashboard" className="text-xs text-muted hover:text-body">
            ← 看板列表
          </Link>
          <span className="text-faint">/</span>
          <h1 className="text-lg font-semibold text-strong">{title}</h1>
          {board?.is_template && (
            <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-medium text-accent">模板</span>
          )}
        </div>
        <Button variant="primary" onClick={() => setBuilder({})}>
          + 添加卡片
        </Button>
      </div>

      {err && <div className="rounded-xl border border-danger/30 bg-danger-soft px-4 py-3 text-xs text-danger">{err}</div>}

      {/* 看板级筛选条 */}
      <BoardFiltersBar filters={filters} onChange={onFiltersChange} groups={groups} />

      {/* 栅格 */}
      {loading ? (
        <div className="py-16 text-center text-xs text-muted">加载中…</div>
      ) : (
        <BoardGrid
          cards={cards}
          boardFilters={filters}
          onLayoutChange={onLayoutChange}
          onEditCard={(c) => setBuilder({ card: c })}
          onDeleteCard={onDeleteCard}
        />
      )}

      {/* AI 解读区（按需生成 + 卡片推荐） */}
      <AiInsightPanel dashboardId={boardId} onAddCard={onSaveCard} />

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

// ── AI 解读区 ──────────────────────────────────────────────
// 按需生成看板解读（POST /api/ai/interpret）+ 推荐卡片（POST /api/ai/suggest）。
// /api/ai/* 尚未上线时（404）优雅降级为「AI 暂不可用」，不崩溃。
type Suggestion = { title: string; measure: string; params?: QueryParams; dims: DimKey[]; viz: VizType; reason: string };

function AiInsightPanel({
  dashboardId,
  onAddCard,
}: {
  dashboardId: number;
  onAddCard: (title: string, config: CardConfig) => void | Promise<void>;
}) {
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [sugLoading, setSugLoading] = useState(false);
  const [sugError, setSugError] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<number>>(new Set());
  const [addingIdx, setAddingIdx] = useState<number | null>(null);

  const post = async (url: string, body: unknown) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 404) return { unavailable: true as const };
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error((json && (json.error as string)) || `HTTP ${res.status}`);
    return { json };
  };

  const generate = async () => {
    setLoading(true);
    setError(null);
    setUnavailable(false);
    try {
      const r = await post("/api/ai/interpret", { dashboardId });
      if ("unavailable" in r) {
        setUnavailable(true);
        return;
      }
      setText(String((r.json as { text?: string })?.text ?? ""));
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally {
      setLoading(false);
    }
  };

  const fetchSuggestions = async () => {
    setSugLoading(true);
    setSugError(null);
    try {
      const r = await post("/api/ai/suggest", { dashboardId });
      if ("unavailable" in r) {
        setUnavailable(true);
        return;
      }
      const list = (r.json as { suggestions?: Suggestion[] })?.suggestions;
      setSuggestions(Array.isArray(list) ? list : []);
    } catch (e) {
      setSugError(String((e as Error)?.message || e));
    } finally {
      setSugLoading(false);
    }
  };

  const add = async (s: Suggestion, i: number) => {
    setAddingIdx(i);
    try {
      await onAddCard(s.title, { measure: s.measure, params: s.params, dims: s.dims, viz: s.viz });
      setAdded((prev) => new Set(prev).add(i));
    } finally {
      setAddingIdx(null);
    }
  };

  return (
    <Panel
      title="✨ AI 解读"
      subtitle="按需读取整个看板数据，生成趋势 / 异常 / 成本效率洞察"
      action={
        text != null ? (
          <Button variant="ghost" onClick={generate} disabled={loading}>
            {loading ? "分析中…" : "重新生成"}
          </Button>
        ) : (
          <Button variant="primary" onClick={generate} disabled={loading}>
            {loading ? "分析中…" : "✨ 生成 AI 解读"}
          </Button>
        )
      }
    >
      {unavailable ? (
        <div className="rounded-lg border border-dashed border-border bg-subtle px-4 py-8 text-center text-xs text-muted">
          AI 暂不可用（服务尚未上线）。
        </div>
      ) : loading && text == null ? (
        <div className="space-y-2">
          <div className="h-3 w-1/3 animate-pulse rounded bg-subtle" />
          <div className="h-3 w-full animate-pulse rounded bg-subtle" />
          <div className="h-3 w-5/6 animate-pulse rounded bg-subtle" />
          <div className="h-3 w-2/3 animate-pulse rounded bg-subtle" />
          <p className="pt-1 text-xs text-muted">分析中…</p>
        </div>
      ) : error ? (
        <div className="space-y-2">
          <div className="rounded-lg border border-danger/30 bg-danger-soft px-4 py-3 text-xs text-danger">生成失败：{error}</div>
          <Button variant="default" onClick={generate}>
            重试
          </Button>
        </div>
      ) : text != null ? (
        <div className="space-y-4">
          <div className="whitespace-pre-wrap rounded-lg border border-border bg-surface px-4 py-3 text-sm leading-relaxed text-body">
            {text || "（无内容）"}
          </div>

          {/* 💡 推荐卡片 */}
          <div className="border-t border-border-hair pt-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-body">💡 推荐卡片</span>
              {suggestions == null ? (
                <Button variant="ghost" onClick={fetchSuggestions} disabled={sugLoading}>
                  {sugLoading ? "获取中…" : "获取推荐"}
                </Button>
              ) : (
                <Button variant="ghost" onClick={fetchSuggestions} disabled={sugLoading}>
                  {sugLoading ? "获取中…" : "刷新推荐"}
                </Button>
              )}
            </div>

            {sugError ? (
              <div className="text-xs text-danger">获取推荐失败：{sugError}</div>
            ) : suggestions && suggestions.length === 0 ? (
              <div className="text-xs text-muted">暂无推荐。</div>
            ) : suggestions ? (
              <div className="space-y-2">
                {suggestions.map((s, i) => (
                  <div
                    key={i}
                    className="flex items-start justify-between gap-3 rounded-lg border border-border bg-surface px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-strong" title={s.title}>
                        {s.title}
                      </div>
                      {s.reason && <p className="mt-0.5 text-xs leading-snug text-muted">{s.reason}</p>}
                    </div>
                    <Button variant="default" onClick={() => add(s, i)} disabled={added.has(i) || addingIdx === i}>
                      {added.has(i) ? "已添加" : addingIdx === i ? "添加中…" : "+ 添加"}
                    </Button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-xs text-muted">
          搭好看板后，点击「生成 AI 解读」获取洞察与卡片推荐。
        </div>
      )}
    </Panel>
  );
}
