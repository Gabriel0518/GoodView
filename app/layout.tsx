import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "./components/AppShell";

export const metadata: Metadata = {
  title: "GoodView · 广告转化看板",
  description: "广告投放 → 转化漏斗 数据看板",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="bg-canvas text-body antialiased">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
