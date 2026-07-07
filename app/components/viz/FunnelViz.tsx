"use client";

import type { QueryRow, QueryMeta } from "../../lib/query-types";
import type { DimKey } from "../../lib/metrics";
import { fmtValue, colorAt } from "./format";

// 漏斗图：X=阶段（dims[0]），按漏斗顺序（引擎已按 ord 排序，不再重排）水平条。
// 转化率 = 相对漏斗顶（第一阶段）的占比。
export function FunnelViz({ rows, meta }: { rows: QueryRow[]; meta: QueryMeta }) {
  const dims = meta.dims as DimKey[];
  const stageDim = dims[0];
  if (!stageDim || !rows.length) return <div className="py-8 text-center text-xs text-zinc-600">无数据</div>;

  const list = rows; // 保持引擎返回的漏斗顺序（ord）
  const top = list[0]?.value || 0;
  const max = Math.max(1, ...list.map((r) => r.value));

  return (
    <div className="space-y-1.5 py-1">
      {list.map((r, i) => {
        const label = String(r[stageDim] ?? "—");
        const pct = (r.value / max) * 100;
        const conv = i === 0 ? null : top ? r.value / top : 0;
        return (
          <div key={`${label}-${i}`} className="group">
            <div className="mb-0.5 flex items-center justify-between text-[11px]">
              <span className="max-w-[70%] truncate text-zinc-300" title={label}>
                {label}
              </span>
              <span className="tnum text-zinc-400">
                {fmtValue(r.value, meta.unit)}
                {conv != null && <span className="ml-1.5 text-zinc-600">{(conv * 100).toFixed(1)}%</span>}
              </span>
            </div>
            <div className="h-5 w-full overflow-hidden rounded bg-ink-850">
              <div
                className="h-full rounded transition-[width]"
                style={{ width: `${Math.max(2, pct)}%`, background: colorAt(i) }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
