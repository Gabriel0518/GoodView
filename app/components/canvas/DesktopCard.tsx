"use client";

// 桌面画布上的看板卡片（v3）：纯文字信息 · 自由拖动（阈值区分点击/拖动）· hover 菜单。
// 类名 nopan 让 react-zoom-pan-pinch 不在拖卡片时平移画布；卡片自己处理指针拖动。
import { useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import type { Dashboard, CanvasPos } from "../board/types";
import { cn } from "../../lib/util";

export const CARD_W = 240;
export const CARD_H = 132;

export function DesktopCard({
  d,
  pos,
  getScale,
  onOpen,
  onMove,
  onMenu,
}: {
  d: Dashboard;
  pos: CanvasPos;
  getScale: () => number;
  onOpen: (id: number) => void;
  onMove: (id: number, pos: CanvasPos) => void;
  onMenu: (id: number, anchor: { x: number; y: number }) => void;
}) {
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  const [p, setP] = useState<CanvasPos>(pos);
  // pos 变化（外部持久化后）同步本地
  if (!drag.current && (p.x !== pos.x || p.y !== pos.y)) setP(pos);

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = { sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y, moved: false };
  };
  const onMovePtr = (e: React.PointerEvent) => {
    const dr = drag.current;
    if (!dr) return;
    const rawDx = e.clientX - dr.sx;
    const rawDy = e.clientY - dr.sy;
    // 点击/拖动判定用【屏幕像素】阈值（不受缩放影响，否则缩小后点击被误判为拖动）
    if (Math.abs(rawDx) > 4 || Math.abs(rawDy) > 4) dr.moved = true;
    const s = getScale() || 1;
    setP({ x: Math.max(0, dr.ox + rawDx / s), y: Math.max(0, dr.oy + rawDy / s) });
  };
  const onUp = (e: React.PointerEvent) => {
    const dr = drag.current;
    drag.current = null;
    if (!dr) return;
    if (dr.moved) {
      const s = getScale() || 1;
      const fx = Math.max(0, dr.ox + (e.clientX - dr.sx) / s);
      const fy = Math.max(0, dr.oy + (e.clientY - dr.sy) / s);
      onMove(d.id, { x: fx, y: fy });
    } else {
      onOpen(d.id);
    }
  };
  // 指针取消（右键/触摸中断等）：复位拖动态，避免 drag.current 卡住导致外部同步失效
  const onCancel = () => { drag.current = null; setP(pos); };

  const bf = d.board_filters;
  const src = bf?.groupId ? `组 #${bf.groupId}` : bf?.accounts?.length ? `账户 ${bf.accounts.length}` : "全渠道";
  const win = bf?.window === "custom" ? "自定义" : (bf?.window || "d30").replace("d", "近") + "天";

  return (
    <div
      className={cn(
        "nopan absolute cursor-grab select-none rounded-xl border border-border bg-surface p-4 shadow-sm transition active:cursor-grabbing hover:shadow-md",
      )}
      style={{ left: p.x, top: p.y, width: CARD_W, minHeight: CARD_H }}
      onPointerDown={onDown}
      onPointerMove={onMovePtr}
      onPointerUp={onUp}
      onPointerCancel={onCancel}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-strong" title={d.name}>{d.name}</div>
          {d.is_template && <span className="mt-1 inline-block rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-medium text-accent">模板</span>}
        </div>
        <button
          className="shrink-0 rounded-md p-1 text-faint hover:bg-subtle hover:text-body"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); onMenu(d.id, { x: r.right, y: r.bottom }); }}
          title="更多"
        >
          <MoreHorizontal size={16} />
        </button>
      </div>
      <div className="mt-4 flex items-center gap-3 text-[11px] text-muted">
        <span className="tnum">{d.card_count ?? 0} 卡片</span>
        <span className="text-border">·</span>
        <span className="truncate" title={src}>{src}</span>
        <span className="text-border">·</span>
        <span>{win}</span>
      </div>
      <div className="mt-3 text-[10px] text-faint">点击打开 · 拖动摆放</div>
    </div>
  );
}
