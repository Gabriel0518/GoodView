// 格式化与导出工具（客户端可用）

export const fmtInt = (n: number) => Math.round(n || 0).toLocaleString("en-US");
export const fmtMoney = (n: number, cur = "USD") =>
  `${cur === "USD" ? "$" : ""}${(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const fmtPct = (n: number, d = 1) => `${((n || 0) * 100).toFixed(d)}%`;
export const fmtNum = (n: number, d = 2) => (n || 0).toLocaleString("en-US", { maximumFractionDigits: d });

export const rate = (n: number, d: number) => (d ? n / d : 0);

// 日期字符串比较（YYYY-MM-DD 可直接字典序）
export const inRange = (d: string, from: string, to: string) => d >= from && d <= to;

export function toCSV(headers: string[], rows: (string | number)[][]): string {
  const esc = (v: string | number) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.map(esc).join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n");
}

export function downloadCSV(filename: string, csv: string) {
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function cn(...xs: (string | false | null | undefined)[]) {
  return xs.filter(Boolean).join(" ");
}
