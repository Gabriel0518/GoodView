"use client";

// v3.3 浮动侧栏（Dock）：左上角悬浮竖条，可折叠。承载 新建看板 / 广告分组 / 事件配置 入口。
// 避开右下角画布缩放控件。折叠态=只显示图标，展开态=图标+文字。
import { useState } from "react";
import { Plus, Layers, SlidersHorizontal, ChevronLeft, ChevronRight } from "lucide-react";

type DockItem = { key: string; label: string; icon: typeof Plus; onClick: () => void };

export function FloatingDock({
  onNewBoard,
  onOpenGroups,
  onOpenEvents,
}: {
  onNewBoard: () => void;
  onOpenGroups: () => void;
  onOpenEvents: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const items: DockItem[] = [
    { key: "new", label: "新建看板", icon: Plus, onClick: onNewBoard },
    { key: "groups", label: "广告分组", icon: Layers, onClick: onOpenGroups },
    { key: "events", label: "事件配置", icon: SlidersHorizontal, onClick: onOpenEvents },
  ];

  return (
    <div className="fixed left-4 top-4 z-20 flex flex-col gap-1.5 rounded-2xl border border-border bg-surface p-2 shadow-md">
      {/* 顶部 Logo + 折叠开关 */}
      <div className="flex items-center gap-2">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent text-sm font-bold text-white shadow-sm">
          G
        </div>
        {expanded && <span className="text-sm font-semibold text-strong">GoodView</span>}
        <button
          onClick={() => setExpanded((v) => !v)}
          className={`grid h-6 w-6 place-items-center rounded-md text-muted hover:bg-subtle hover:text-body ${expanded ? "ml-auto" : "ml-0"}`}
          title={expanded ? "折叠" : "展开"}
        >
          {expanded ? <ChevronLeft size={15} /> : <ChevronRight size={15} />}
        </button>
      </div>

      <div className="my-0.5 h-px bg-border-hair" />

      {/* 功能项 */}
      {items.map((it) => {
        const Icon = it.icon;
        return (
          <button
            key={it.key}
            onClick={it.onClick}
            title={it.label}
            className={`flex items-center gap-2.5 rounded-xl px-2 py-2 text-sm text-body transition hover:bg-accent-soft hover:text-accent ${expanded ? "w-40 justify-start" : "w-9 justify-center"}`}
          >
            <Icon size={18} className="shrink-0" />
            {expanded && <span className="truncate">{it.label}</span>}
          </button>
        );
      })}
    </div>
  );
}
