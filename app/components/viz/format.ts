// 按度量单位格式化数值 + 序列配色（浅色 SaaS 数据可视化调色板）。
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

// 序列配色（accent 起头；UI-设计需求.md §2.1 / §6 调色板）
export const SERIES_COLORS = [
  "#4F46E5", // accent indigo
  "#0EA5E9", // sky
  "#10B981", // emerald
  "#F59E0B", // amber
  "#EC4899", // pink
  "#8B5CF6", // violet
  "#64748B", // slate
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
