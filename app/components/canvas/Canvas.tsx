"use client";

// v3 桌面画布：react-zoom-pan-pinch 缩放/平移；看板卡片自由摆放（绝对定位）。
// 空白处拖动=平移画布；滚轮=缩放；卡片(.nopan)自己处理拖动。
import { useRef } from "react";
import { TransformWrapper, TransformComponent, useControls, type ReactZoomPanPinchRef } from "react-zoom-pan-pinch";
import { Plus, Minus, Maximize } from "lucide-react";
import type { Dashboard, CanvasPos } from "../board/types";
import { DesktopCard, CARD_W, CARD_H } from "./DesktopCard";

const CANVAS_W = 4000;
const CANVAS_H = 3000;

// 无坐标的看板给个错开的默认位（按序网格）
export function defaultPos(i: number): CanvasPos {
  const cols = 4;
  return { x: 48 + (i % cols) * (CARD_W + 40), y: 48 + Math.floor(i / cols) * (CARD_H + 40) };
}

function Controls() {
  const { zoomIn, zoomOut, resetTransform } = useControls();
  const btn = "grid h-8 w-8 place-items-center rounded-lg border border-border bg-surface text-muted shadow-sm hover:bg-subtle hover:text-body";
  return (
    <div className="absolute bottom-5 right-5 z-10 flex flex-col gap-1.5">
      <button className={btn} onClick={() => zoomIn()} title="放大"><Plus size={16} /></button>
      <button className={btn} onClick={() => zoomOut()} title="缩小"><Minus size={16} /></button>
      <button className={btn} onClick={() => resetTransform()} title="复位"><Maximize size={16} /></button>
    </div>
  );
}

export function Canvas({
  dashboards,
  onOpen,
  onMove,
  onMenu,
}: {
  dashboards: Dashboard[];
  onOpen: (id: number) => void;
  onMove: (id: number, pos: CanvasPos) => void;
  onMenu: (id: number, anchor: { x: number; y: number }) => void;
}) {
  const scaleRef = useRef<ReactZoomPanPinchRef>(null);
  const getScale = () => scaleRef.current?.state.scale ?? 1;

  return (
    <div className="relative h-full w-full overflow-hidden bg-canvas">
      {/* 点状底纹，强化"画布"感 */}
      <TransformWrapper
        ref={scaleRef}
        initialScale={1}
        minScale={0.3}
        maxScale={2}
        limitToBounds={false}
        centerOnInit={false}
        wheel={{ step: 0.08 }}
        doubleClick={{ disabled: true }}
        panning={{ excluded: ["nopan"] }}
      >
        <Controls />
        <TransformComponent wrapperStyle={{ width: "100%", height: "100%" }} contentStyle={{ width: CANVAS_W, height: CANVAS_H }}>
          <div
            className="relative"
            style={{
              width: CANVAS_W,
              height: CANVAS_H,
              backgroundImage: "radial-gradient(#E5E7EB 1px, transparent 1px)",
              backgroundSize: "24px 24px",
            }}
          >
            {dashboards.map((d, i) => {
              const c = d.canvas;
              const pos = c && typeof c.x === "number" && typeof c.y === "number" ? { x: c.x, y: c.y } : defaultPos(i);
              return (
                <DesktopCard key={d.id} d={d} pos={pos} getScale={getScale} onOpen={onOpen} onMove={onMove} onMenu={onMenu} />
              );
            })}
          </div>
        </TransformComponent>
      </TransformWrapper>
    </div>
  );
}
