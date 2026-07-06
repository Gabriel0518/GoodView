import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "广告转化看板",
  description: "广告投放 → 转化漏斗 数据看板",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen bg-ink-950 text-zinc-200 antialiased">{children}</body>
    </html>
  );
}
