"use client";

// 步骤 3：选图表。可用性由「已选维度数量」+ VIZ_META 的 [minDims,maxDims] 决定。
// 特例：漏斗图仅当唯一维度是「阶段」时可用。
import type { DimKey, VizType } from "../../lib/metrics";
import { VIZ_META } from "../../lib/metrics";
import { cn } from "../../lib/util";

const VIZ_ORDER: VizType[] = ["number", "line", "bar", "table", "funnel"];

// 某图表在当前维度下是否可用 + 不可用原因
export function vizAvailability(viz: VizType, dims: DimKey[]): { ok: boolean; reason?: string } {
  const meta = VIZ_META[viz];
  const n = dims.length;
  if (viz === "funnel") {
    if (dims[0] !== "stage" || n !== 1) return { ok: false, reason: "漏斗图需以「阶段」为唯一维度" };
    return { ok: true };
  }
  if (viz === "line" && n >= 1 && dims[0] !== "date") {
    return { ok: false, reason: "折线图 X 轴需为「日期」" };
  }
  if (n < meta.minDims) return { ok: false, reason: `至少需 ${meta.minDims} 个维度` };
  if (n > meta.maxDims) return { ok: false, reason: `最多支持 ${meta.maxDims} 个维度` };
  return { ok: true };
}

export function VizPicker({
  dims,
  value,
  onChange,
}: {
  dims: DimKey[];
  value: VizType | null;
  onChange: (v: VizType) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {VIZ_ORDER.map((viz) => {
        const { ok, reason } = vizAvailability(viz, dims);
        const selected = value === viz;
        return (
          <button
            key={viz}
            onClick={() => ok && onChange(viz)}
            disabled={!ok}
            title={ok ? VIZ_META[viz].label : reason}
            className={cn(
              "rounded-lg border px-2.5 py-1.5 text-xs transition",
              selected && ok && "border-accent bg-accent-soft text-accent",
              !selected && ok && "border-border bg-surface text-body hover:bg-subtle",
              !ok && "cursor-not-allowed border-border bg-subtle text-faint",
            )}
          >
            {VIZ_META[viz].label}
          </button>
        );
      })}
    </div>
  );
}
