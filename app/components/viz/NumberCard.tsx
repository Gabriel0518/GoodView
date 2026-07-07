"use client";

import type { QueryRow, QueryMeta } from "../../lib/query-types";
import { fmtValue } from "./format";

// 数字卡：0 维 → 单值。无数据显示"—"（区分"0"与"无数据"，§6）。
export function NumberCard({ rows, meta }: { rows: QueryRow[]; meta: QueryMeta }) {
  const hasData = rows.length > 0;
  return (
    <div className="flex h-full min-h-[120px] flex-col items-center justify-center">
      <div className="tnum text-[32px] font-semibold leading-tight text-strong">
        {hasData ? fmtValue(rows[0].value, meta.unit) : "—"}
      </div>
      <div className="mt-1 text-xs text-muted">{meta.measure}</div>
    </div>
  );
}
