"use client";

import type { QueryRow, QueryMeta } from "../../lib/query-types";
import type { DimKey } from "../../lib/metrics";
import { LineChart } from "../charts";
import { fmtValue, colorAt, uniq } from "./format";

// 折线：X=日期（dims[0]）；可选 dims[1]=序列维度。
export function LineViz({ rows, meta }: { rows: QueryRow[]; meta: QueryMeta }) {
  const dims = meta.dims as DimKey[];
  const xDim = dims[0];
  const seriesDim = dims[1];
  if (!xDim) return <Empty />;

  const labels = uniq(rows.map((r) => String(r[xDim] ?? ""))).sort();
  const idx = new Map(labels.map((l, i) => [l, i]));

  let series: { name: string; color: string; values: number[] }[];
  if (seriesDim) {
    const names = uniq(rows.map((r) => String(r[seriesDim] ?? "—")));
    series = names.map((name, si) => {
      const values = new Array(labels.length).fill(0);
      for (const r of rows) {
        if (String(r[seriesDim] ?? "—") !== name) continue;
        const i = idx.get(String(r[xDim] ?? ""));
        if (i != null) values[i] = r.value;
      }
      return { name, color: colorAt(si), values };
    });
  } else {
    const values = new Array(labels.length).fill(0);
    for (const r of rows) {
      const i = idx.get(String(r[xDim] ?? ""));
      if (i != null) values[i] = r.value;
    }
    series = [{ name: meta.measure, color: colorAt(0), values }];
  }

  if (!labels.length) return <Empty />;

  return (
    <div className="space-y-2">
      <LineChart labels={labels} series={series} valueFmt={(v) => fmtValue(v, meta.unit)} />
      {seriesDim && series.length > 1 && (
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {series.map((s) => (
            <span key={s.name} className="inline-flex items-center gap-1 text-[11px] text-zinc-400">
              <span className="inline-block h-2 w-2 rounded-sm" style={{ background: s.color }} />
              <span className="max-w-[140px] truncate" title={s.name}>
                {s.name}
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function Empty() {
  return <div className="py-8 text-center text-xs text-zinc-600">无数据</div>;
}
