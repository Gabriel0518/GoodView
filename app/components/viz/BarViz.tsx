"use client";

import type { QueryRow, QueryMeta } from "../../lib/query-types";
import type { DimKey } from "../../lib/metrics";
import { DIM_META } from "../../lib/metrics";
import { fmtValue, colorAt, uniq } from "./format";

// 柱状：X=dims[0]；可选 dims[1]=分组序列（并列柱）。手绘 SVG。
export function BarViz({ rows, meta }: { rows: QueryRow[]; meta: QueryMeta }) {
  const dims = meta.dims as DimKey[];
  const xDim = dims[0];
  const seriesDim = dims[1];
  if (!xDim) return <Empty />;

  const cats = uniq(rows.map((r) => String(r[xDim] ?? "—")));
  const seriesNames = seriesDim ? uniq(rows.map((r) => String(r[seriesDim] ?? "—"))) : [meta.measure];

  // 取值矩阵 [cat][series]
  const cell = new Map<string, number>();
  for (const r of rows) {
    const c = String(r[xDim] ?? "—");
    const s = seriesDim ? String(r[seriesDim] ?? "—") : meta.measure;
    cell.set(`${c}|${s}`, (cell.get(`${c}|${s}`) ?? 0) + r.value);
  }
  const valOf = (c: string, s: string) => cell.get(`${c}|${s}`) ?? 0;
  const max = Math.max(1, ...cats.flatMap((c) => seriesNames.map((s) => valOf(c, s))));

  const w = 640;
  const h = 240;
  const padL = 52;
  const padR = 14;
  const padT = 14;
  const padB = 46;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const groupW = plotW / Math.max(1, cats.length);
  const barGap = 3;
  const innerW = Math.max(6, groupW * 0.72);
  const barW = Math.max(3, (innerW - barGap * (seriesNames.length - 1)) / seriesNames.length);

  const Y = (v: number) => padT + (1 - v / max) * plotH;
  const grid = [0, 0.5, 1].map((t) => t * max);

  return (
    <div className="space-y-2">
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ height: h }}>
        {grid.map((g, i) => (
          <g key={i}>
            <line x1={padL} x2={w - padR} y1={Y(g)} y2={Y(g)} stroke="#F1F3F5" strokeWidth={1} />
            <text x={padL - 8} y={Y(g) + 3} textAnchor="end" fontSize={10} fill="#9CA3AF" className="tnum">
              {fmtValue(g, meta.unit)}
            </text>
          </g>
        ))}
        {cats.map((c, ci) => {
          const gx = padL + ci * groupW + (groupW - innerW) / 2;
          return (
            <g key={c}>
              {seriesNames.map((s, si) => {
                const v = valOf(c, s);
                const bh = Math.max(0, padT + plotH - Y(v));
                const x = gx + si * (barW + barGap);
                return <rect key={s} x={x} y={Y(v)} width={barW} height={bh} rx={1.5} fill={colorAt(si)} />;
              })}
              <text
                x={padL + ci * groupW + groupW / 2}
                y={h - 28}
                textAnchor="middle"
                fontSize={10}
                fill="#9CA3AF"
              >
                {truncate(c, 10)}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {seriesDim && (
          <span className="text-[11px] text-muted">{DIM_META[seriesDim].label}：</span>
        )}
        {seriesNames.map((s, si) => (
          <span key={s} className="inline-flex items-center gap-1 text-[11px] text-muted">
            <span className="inline-block h-2 w-2 rounded-sm" style={{ background: colorAt(si) }} />
            <span className="max-w-[140px] truncate" title={s}>
              {s}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function Empty() {
  return <div className="py-8 text-center text-xs text-muted">无数据</div>;
}
