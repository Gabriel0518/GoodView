"use client";

import type { QueryRow, QueryMeta } from "../../lib/query-types";
import type { DimKey } from "../../lib/metrics";
import { DIM_META } from "../../lib/metrics";
import { fmtValue, uniq } from "./format";
import { downloadCSV, toCSV } from "../../lib/util";
import { Button } from "../ui";

// 透视表：最多 3 维。最后一维作列，其余维作行（嵌套分组）。
export function TableViz({ rows, meta }: { rows: QueryRow[]; meta: QueryMeta }) {
  const dims = meta.dims as DimKey[];
  if (!dims.length) {
    // 0 维兜底：单值
    return (
      <div className="p-2">
        <table className="w-full text-sm">
          <tbody>
            <tr>
              <td className="py-1 text-muted">{meta.measure}</td>
              <td className="tnum py-1 text-right text-strong">{fmtValue(rows[0]?.value ?? 0, meta.unit)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    );
  }

  // 一维：两列表
  if (dims.length === 1) {
    const d = dims[0];
    const list = [...rows].sort((a, b) => b.value - a.value);
    const csv = () =>
      downloadCSV(
        `${meta.measure}.csv`,
        toCSV([DIM_META[d].label, meta.measure], list.map((r) => [String(r[d] ?? ""), r.value])),
      );
    return (
      <TableShell onExport={csv}>
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border bg-subtle text-muted">
              <th className="px-2 py-1.5 text-left font-medium">{DIM_META[d].label}</th>
              <th className="px-2 py-1.5 text-right font-medium">{meta.measure}</th>
            </tr>
          </thead>
          <tbody>
            {list.map((r, i) => (
              <tr key={i} className="border-b border-border-hair hover:bg-subtle">
                <td className="max-w-[220px] truncate px-2 py-1.5 text-body" title={String(r[d] ?? "")}>
                  {String(r[d] ?? "—")}
                </td>
                <td className="tnum px-2 py-1.5 text-right text-strong">{fmtValue(r.value, meta.unit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableShell>
    );
  }

  // 二维/三维：末维=列，前面维=行分组
  const colDim = dims[dims.length - 1];
  const rowDims = dims.slice(0, -1);
  const rowKey = (r: QueryRow) => rowDims.map((d) => String(r[d] ?? "")).join(" ▏ ");
  const rowKeys = uniq(rows.map(rowKey));
  const colKeys = uniq(rows.map((r) => String(r[colDim] ?? "")));
  const cell = new Map<string, number>();
  for (const r of rows) cell.set(`${rowKey(r)}||${String(r[colDim] ?? "")}`, r.value);
  const get = (rk: string, ck: string) => cell.get(`${rk}||${ck}`);

  const rowLabelParts = (rk: string) => rk.split(" ▏ ");

  const csv = () => {
    const headers = [...rowDims.map((d) => DIM_META[d].label), ...colKeys];
    const body = rowKeys.map((rk) => [...rowLabelParts(rk), ...colKeys.map((ck) => get(rk, ck) ?? "")]);
    downloadCSV(`${meta.measure}-pivot.csv`, toCSV(headers, body));
  };

  return (
    <TableShell onExport={csv}>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border bg-subtle text-muted">
              {rowDims.map((d) => (
                <th key={d} className="px-2 py-1.5 text-left font-medium">
                  {DIM_META[d].label}
                </th>
              ))}
              {colKeys.map((ck) => (
                <th key={ck} className="px-2 py-1.5 text-right font-medium">
                  <span className="max-w-[120px] truncate" title={ck}>
                    {ck || "—"}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rowKeys.map((rk) => (
              <tr key={rk} className="border-b border-border-hair hover:bg-subtle">
                {rowLabelParts(rk).map((p, i) => (
                  <td key={i} className="max-w-[160px] truncate px-2 py-1.5 text-body" title={p}>
                    {p || "—"}
                  </td>
                ))}
                {colKeys.map((ck) => {
                  const v = get(rk, ck);
                  return (
                    <td key={ck} className="tnum px-2 py-1.5 text-right text-strong">
                      {v == null ? <span className="text-faint">—</span> : fmtValue(v, meta.unit)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </TableShell>
  );
}

function TableShell({ onExport, children }: { onExport: () => void; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <Button variant="ghost" onClick={onExport}>
          导出 CSV
        </Button>
      </div>
      {children}
    </div>
  );
}
