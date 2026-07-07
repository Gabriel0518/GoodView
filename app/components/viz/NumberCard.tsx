"use client";

import type { QueryRow, QueryMeta } from "../../lib/query-types";
import { fmtValue } from "./format";

// 数字卡：0 维 → 单值。
export function NumberCard({ rows, meta }: { rows: QueryRow[]; meta: QueryMeta }) {
  const value = rows.length ? rows[0].value : 0;
  return (
    <div className="flex h-full min-h-[120px] flex-col items-center justify-center">
      <div className="tnum text-3xl font-semibold text-zinc-100">{fmtValue(value, meta.unit)}</div>
      <div className="mt-1 text-xs text-zinc-500">{meta.measure}</div>
    </div>
  );
}
