"use client";

// v2 首页：看板列表。支持 新建 / 打开 / 复制 / 存为模板 / 删除。
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { Dashboard } from "./types";
import { DEFAULT_BOARD_FILTERS } from "./types";
import { listDashboards, createDashboard, copyDashboard, updateDashboard, deleteDashboard } from "./api";
import { Panel, Button } from "../ui";
import { cn } from "../../lib/util";

export function BoardList() {
  const [boards, setBoards] = useState<Dashboard[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | "new" | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const data = await listDashboards();
      setBoards(Array.isArray(data) ? data : []);
    } catch (e) {
      setErr(String((e as Error)?.message || e));
      setBoards([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const create = async () => {
    const name = window.prompt("看板名称", "新看板");
    if (!name?.trim()) return;
    setBusy("new");
    try {
      await createDashboard(name.trim(), DEFAULT_BOARD_FILTERS);
      await load();
    } catch (e) {
      setErr(String((e as Error)?.message || e));
    } finally {
      setBusy(null);
    }
  };

  const act = async (id: number, fn: () => Promise<unknown>) => {
    setBusy(id);
    setErr(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setErr(String((e as Error)?.message || e));
    } finally {
      setBusy(null);
    }
  };

  const copy = (b: Dashboard) => act(b.id, () => copyDashboard(b.id));
  const saveTemplate = (b: Dashboard) => act(b.id, () => updateDashboard(b.id, { is_template: true }));
  const remove = (b: Dashboard) => {
    if (!window.confirm(`删除看板「${b.name}」？此操作不可撤销。`)) return;
    return act(b.id, () => deleteDashboard(b.id));
  };

  return (
    <main className="mx-auto max-w-5xl space-y-4 px-4 py-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">看板</h1>
          <p className="mt-1 text-xs text-zinc-500">自助搭建广告转化看板 · 选度量 → 配维度 → 拖拽栅格 → AI 解读</p>
          <div className="mt-1.5 flex items-center gap-3 text-xs">
            <Link href="/admin/groups" className="text-zinc-500 hover:text-accent-soft">管理分组</Link>
            <Link href="/legacy" className="text-zinc-500 hover:text-accent-soft">旧版看板</Link>
          </div>
        </div>
        <Button variant="primary" onClick={create} disabled={busy === "new"}>
          {busy === "new" ? "创建中…" : "+ 新建看板"}
        </Button>
      </div>

      {err && <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-xs text-red-300">{err}</div>}

      <Panel title="全部看板" subtitle={boards ? `${boards.length} 个` : undefined} action={<Button variant="ghost" onClick={load} disabled={loading}>{loading ? "加载中…" : "刷新"}</Button>}>
        {loading ? (
          <div className="py-10 text-center text-xs text-zinc-600">加载中…</div>
        ) : !boards || boards.length === 0 ? (
          <div className="py-10 text-center text-xs text-zinc-600">还没有看板。点击右上角「新建看板」创建第一个。</div>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {boards.map((b) => (
              <div
                key={b.id}
                className={cn(
                  "flex flex-col justify-between gap-3 rounded-xl border border-ink-700 bg-ink-850 p-4",
                  busy === b.id && "opacity-60",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <Link href={`/dashboard/${b.id}`} className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-zinc-100 hover:text-accent-soft" title={b.name}>
                        {b.name}
                      </span>
                      {b.is_template && (
                        <span className="shrink-0 rounded bg-accent/20 px-1.5 py-0.5 text-[10px] font-medium text-accent-soft">模板</span>
                      )}
                    </div>
                  </Link>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Link href={`/dashboard/${b.id}`}>
                    <Button variant="default">打开</Button>
                  </Link>
                  <Button variant="ghost" onClick={() => copy(b)} disabled={busy === b.id}>
                    复制
                  </Button>
                  <Button variant="ghost" onClick={() => saveTemplate(b)} disabled={busy === b.id || b.is_template}>
                    存为模板
                  </Button>
                  <Button variant="ghost" onClick={() => remove(b)} disabled={busy === b.id}>
                    删除
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </main>
  );
}
