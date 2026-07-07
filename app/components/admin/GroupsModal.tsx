"use client";

// 广告分组弹窗：从浮动侧栏打开（深链 ?modal=groups）。复用 BoardModal 外壳模式。
// 注：不监听 Esc 关闭——内层组编辑器打开时 Esc 会误关整个弹窗、丢草稿。用 X / 背景点击关闭。
import { X } from "lucide-react";
import { GroupsManager } from "./GroupsManager";

export function GroupsModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-strong/40 p-3 sm:p-6" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="mx-auto flex h-full w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border bg-canvas shadow-md">
        <header className="flex items-center justify-between gap-3 border-b border-border bg-surface px-5 py-3">
          <h1 className="text-[15px] font-semibold text-strong">广告分组</h1>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-subtle hover:text-body" title="关闭"><X size={18} /></button>
        </header>
        <div className="flex-1 overflow-auto p-5">
          <GroupsManager />
        </div>
      </div>
    </div>
  );
}
