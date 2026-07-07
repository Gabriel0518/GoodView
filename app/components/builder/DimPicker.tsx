"use client";

// 步骤 2：选维度（引导式灰掉核心）。
// 对每个维度用 isDimAllowed(measure, dim) 判定可选；不可选的灰掉并给出 tooltip 解释原因（双立方体约束）。
// 选择有序：第 1 个=X 轴，第 2 个=序列/Y，第 3 个=Z。上限由 maxDims 控制。
import type { DimKey } from "../../lib/metrics";
import { DIM_META, getMeasure, isDimAllowed } from "../../lib/metrics";
import { cn } from "../../lib/util";

const ALL_DIMS: DimKey[] = ["date", "channel", "account", "campaign", "adset", "source", "stage"];
const POS_LABEL = ["X 轴", "序列/Y", "Z"];

// 不可选维度的原因（结合度量所属立方体）
export function dimReason(measureKey: string, dim: DimKey): string | null {
  const m = getMeasure(measureKey);
  if (!m || m.allowedDims.includes(dim)) return null;
  const allowed = m.allowedDims.map((d) => DIM_META[d].label).join("、");
  const base = `「${m.label}」不能按「${DIM_META[dim].label}」拆分（仅支持：${allowed}）`;
  if (m.cube === "cross") return `${base}。跨立方度量只能在 日期 + 渠道↔来源 对齐上聚合。`;
  if (m.cube === "funnel") return `${base}。漏斗立方体没有渠道/账户/系列维度。`;
  return `${base}。花费立方体没有来源/阶段维度。`;
}

export function DimPicker({
  measure,
  dims,
  onChange,
  maxDims = 3,
}: {
  measure: string;
  dims: DimKey[];
  onChange: (dims: DimKey[]) => void;
  maxDims?: number;
}) {
  const toggle = (dim: DimKey) => {
    if (dims.includes(dim)) {
      onChange(dims.filter((d) => d !== dim));
    } else {
      if (dims.length >= maxDims) return;
      onChange([...dims, dim]);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {ALL_DIMS.map((dim) => {
          const allowed = measure ? isDimAllowed(measure, dim) : false;
          const pos = dims.indexOf(dim);
          const selected = pos >= 0;
          const atCap = !selected && dims.length >= maxDims;
          const reason = measure ? dimReason(measure, dim) : "请先选择度量";
          // 已选维度必须始终可移除（即使因度量切换后变为不兼容），否则会卡住无法取消。
          const clickable = allowed || selected;
          return (
            <button
              key={dim}
              onClick={() => clickable && toggle(dim)}
              disabled={!clickable}
              title={!allowed ? reason ?? undefined : atCap ? `最多 ${maxDims} 个维度` : DIM_META[dim].label}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition",
                selected && "border-accent bg-accent/20 text-accent-soft",
                !selected && allowed && !atCap && "border-ink-700 bg-ink-850 text-zinc-300 hover:border-ink-600",
                !selected && allowed && atCap && "border-ink-800 bg-ink-850 text-zinc-500",
                !allowed && "cursor-not-allowed border-ink-800 bg-ink-900/40 text-zinc-700",
              )}
            >
              {DIM_META[dim].label}
              {selected && <span className="rounded bg-accent/30 px-1 text-[9px] text-accent-soft">{POS_LABEL[pos]}</span>}
              {!allowed && <span className="text-[10px]">🔒</span>}
            </button>
          );
        })}
      </div>
      <p className="text-[11px] text-zinc-600">
        {dims.length === 0
          ? "未选维度 → 数字卡（单值）"
          : `已选 ${dims.length}/${maxDims} 维 · 顺序即 ${dims.map((d, i) => `${POS_LABEL[i]}=${DIM_META[d].label}`).join(" · ")}`}
      </p>
    </div>
  );
}
