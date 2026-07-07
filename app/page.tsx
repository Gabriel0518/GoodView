"use client";

// v3 首页 = 桌面画布。看板以卡片自由摆放；点卡片开看板弹窗(?board 深链)；滚轮缩放。
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Plus } from "lucide-react";
import type { Dashboard, CanvasPos } from "./components/board/types";
import { DEFAULT_BOARD_FILTERS } from "./components/board/types";
import { listDashboards, createDashboard, copyDashboard, updateDashboard, deleteDashboard } from "./components/board/api";
import { Canvas, defaultPos } from "./components/canvas/Canvas";
import { BoardModal } from "./components/board/BoardModal";

export default function Page() {
  return (
    <Suspense fallback={<div className="grid h-full place-items-center text-sm text-muted">加载中…</div>}>
      <CanvasHome />
    </Suspense>
  );
}

type Menu = { id: number; x: number; y: number } | null;

function CanvasHome() {
  const router = useRouter();
  const params = useSearchParams();
  const boardParam = params.get("board");
  const boardId = boardParam && /^\d+$/.test(boardParam) ? Number(boardParam) : null;

  const [dashboards, setDashboards] = useState<Dashboard[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const busy = useRef(false);

  const load = useCallback(async () => {
    try {
      const data = await listDashboards();
      setDashboards(Array.isArray(data) ? data : []);
    } catch (e) {
      setErr(String((e as Error)?.message || e));
      setDashboards([]);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openBoard = (id: number) => router.push(`/?board=${id}`);
  const closeBoard = () => { router.push("/"); load(); };

  // 拖动卡片 → 乐观更新 + 持久化 canvas 坐标
  const moveCard = (id: number, pos: CanvasPos) => {
    setDashboards((ds) => ds?.map((d) => (d.id === id ? { ...d, canvas: pos } : d)) ?? null);
    updateDashboard(id, { canvas: pos }).catch((e) => setErr(String((e as Error)?.message || e)));
  };

  const newBoard = async () => {
    if (busy.current) return;
    const name = window.prompt("看板名称", "新看板");
    if (!name?.trim()) return;
    busy.current = true;
    try {
      const pos = defaultPos(dashboards?.length ?? 0);
      const { id } = await createDashboard(name.trim(), DEFAULT_BOARD_FILTERS, pos);
      await load();
      openBoard(id);
    } catch (e) {
      setErr(String((e as Error)?.message || e));
    } finally {
      busy.current = false;
    }
  };

  const act = async (fn: () => Promise<unknown>) => {
    setMenu(null);
    try { await fn(); await load(); } catch (e) { setErr(String((e as Error)?.message || e)); }
  };

  const menuBoard = menu ? dashboards?.find((d) => d.id === menu.id) : null;

  return (
    <div className="relative h-full w-full" onClick={() => menu && setMenu(null)}>
      {dashboards === null ? (
        <div className="grid h-full place-items-center text-sm text-muted">加载中…</div>
      ) : dashboards.length === 0 ? (
        <div className="grid h-full place-items-center">
          <div className="text-center">
            <p className="text-sm text-muted">桌面上还没有看板。</p>
            <button onClick={newBoard} className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-accent-600">
              <Plus size={16} /> 新建看板
            </button>
          </div>
        </div>
      ) : (
        <Canvas dashboards={dashboards} onOpen={openBoard} onMove={moveCard} onMenu={(id, a) => setMenu({ id, x: a.x, y: a.y })} />
      )}

      {/* 临时新建按钮（V3.3 移入浮动侧栏） */}
      {dashboards && dashboards.length > 0 && (
        <button onClick={newBoard} className="absolute left-5 top-5 z-20 inline-flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white shadow-md hover:bg-accent-600">
          <Plus size={16} /> 新建看板
        </button>
      )}

      {err && <div className="absolute bottom-5 left-5 z-20 max-w-sm rounded-xl border border-danger/30 bg-danger-soft px-4 py-2.5 text-xs text-danger shadow-sm">{err}</div>}

      {/* 卡片右键/更多 菜单 */}
      {menu && menuBoard && (
        <div className="fixed z-30 w-40 rounded-xl border border-border bg-surface p-1 shadow-md" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          {[
            { label: "打开", fn: () => { setMenu(null); openBoard(menu.id); } },
            { label: "复制", fn: () => act(() => copyDashboard(menu.id)) },
            { label: menuBoard.is_template ? "已是模板" : "存为模板", fn: () => act(() => updateDashboard(menu.id, { is_template: true })), disabled: menuBoard.is_template },
            { label: "重命名", fn: () => { const n = window.prompt("重命名看板", menuBoard.name); if (n?.trim()) act(() => updateDashboard(menu.id, { name: n.trim() })); else setMenu(null); } },
            { label: "删除", danger: true, fn: () => { if (window.confirm(`删除看板「${menuBoard.name}」？`)) act(() => deleteDashboard(menu.id)); else setMenu(null); } },
          ].map((it) => (
            <button
              key={it.label}
              disabled={it.disabled}
              onClick={it.fn}
              className={`block w-full rounded-md px-3 py-1.5 text-left text-xs disabled:opacity-50 ${it.danger ? "text-danger hover:bg-danger-soft" : "text-body hover:bg-subtle"}`}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}

      {/* 看板弹窗（深链 ?board） */}
      {boardId != null && <BoardModal boardId={boardId} onClose={closeBoard} />}
    </div>
  );
}
