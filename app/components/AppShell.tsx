"use client";

// 全局骨架：左侧栏(240) + 顶栏 + 内容区（UI-设计需求.md §3）。浅色 SaaS 结构。
import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Layers, SlidersHorizontal, Menu, X } from "lucide-react";
import { cn } from "../lib/util";

const NAV = [
  { href: "/", label: "看板", icon: LayoutDashboard, match: (p: string) => p === "/" || p.startsWith("/dashboard") },
  { href: "/admin/groups", label: "广告分组", icon: Layers, match: (p: string) => p.startsWith("/admin/groups") },
  { href: "/admin/events", label: "事件配置", icon: SlidersHorizontal, match: (p: string) => p.startsWith("/admin/events") },
];

function NavList({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return (
    <nav className="flex flex-col gap-0.5 px-3">
      {NAV.map((item) => {
        const active = item.match(pathname);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            className={cn(
              "relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition",
              active
                ? "bg-accent-soft font-medium text-accent"
                : "text-muted hover:bg-subtle hover:text-body",
            )}
          >
            {active && <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-accent" />}
            <Icon size={18} strokeWidth={1.75} />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || "/";
  const [drawer, setDrawer] = useState(false);

  return (
    <div className="min-h-screen bg-canvas">
      {/* 桌面侧栏 */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-border bg-surface lg:flex">
        <div className="flex h-14 items-center gap-2 px-5">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-accent text-sm font-bold text-white">G</span>
          <span className="text-[15px] font-semibold text-strong">GoodView</span>
        </div>
        <div className="mt-2 flex-1">
          <NavList pathname={pathname} />
        </div>
        <div className="border-t border-border px-5 py-3 text-[11px] text-faint">数据每 5 分钟自动更新</div>
      </aside>

      {/* 移动抽屉 */}
      {drawer && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-strong/20" onClick={() => setDrawer(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-60 flex-col border-r border-border bg-surface">
            <div className="flex h-14 items-center justify-between px-5">
              <span className="text-[15px] font-semibold text-strong">GoodView</span>
              <button onClick={() => setDrawer(false)} className="text-muted hover:text-body"><X size={18} /></button>
            </div>
            <NavList pathname={pathname} onNavigate={() => setDrawer(false)} />
          </aside>
        </div>
      )}

      {/* 内容区 */}
      <div className="lg:pl-60">
        {/* 顶栏（移动端汉堡） */}
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-surface/80 px-4 backdrop-blur lg:hidden">
          <button onClick={() => setDrawer(true)} className="text-muted hover:text-body"><Menu size={20} /></button>
          <span className="text-sm font-semibold text-strong">GoodView</span>
        </header>
        <div className="min-h-[calc(100vh-3.5rem)]">{children}</div>
      </div>
    </div>
  );
}
