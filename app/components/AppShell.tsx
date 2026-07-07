"use client";

// v3：去掉固定侧栏，全屏容器（画布铺满视口）。浮动侧栏(FloatingDock)在 V3.3 加。
export function AppShell({ children }: { children: React.ReactNode }) {
  return <div className="h-screen w-screen overflow-hidden bg-canvas">{children}</div>;
}
