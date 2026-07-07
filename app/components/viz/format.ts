// 按度量单位格式化数值 + 序列配色（与深色主题一致）。
import { fmtInt, fmtMoney, fmtNum, fmtPct } from "../../lib/util";

export function fmtValue(v: number, unit?: string): string {
  switch (unit) {
    case "money":
      return fmtMoney(v);
    case "pct":
      return fmtPct(v);
    case "ratio":
      return fmtNum(v);
    case "int":
    default:
      return fmtInt(v);
  }
}

// 序列配色（accent 起头，循环取用）
export const SERIES_COLORS = [
  "#7c8cff",
  "#5ad1c8",
  "#f6c177",
  "#f38ba8",
  "#a6da95",
  "#c9a0ff",
  "#7bd3f7",
  "#f7a072",
  "#9aa6ff",
  "#e0af68",
];

export const colorAt = (i: number) => SERIES_COLORS[i % SERIES_COLORS.length];

// 稳定去重（保持首次出现顺序）
export function uniq<T>(xs: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const x of xs) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}
