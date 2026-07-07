"use client";

// 看板级筛选条：数据源（分组）/ 日期窗口 / 粒度。作为所有卡片查询的「底」。
import type { Granularity } from "../../lib/metrics";
import type { QueryFilters } from "../../lib/query-types";
import type { BoardFilters, BoardGroup } from "./types";
import { Segmented } from "../ui";
import { Select } from "../controls";

type Win = NonNullable<QueryFilters["window"]>;
const WINDOWS: { value: Win; label: string }[] = [
  { value: "d7", label: "近7天" },
  { value: "d30", label: "近30天" },
  { value: "d90", label: "近90天" },
  { value: "d365", label: "近一年" },
  { value: "custom", label: "自定义" },
];
const GRANS: { value: Granularity; label: string }[] = [
  { value: "day", label: "日" },
  { value: "month", label: "月" },
  { value: "year", label: "年" },
];

export function BoardFiltersBar({
  filters,
  onChange,
  groups,
}: {
  filters: BoardFilters;
  onChange: (next: BoardFilters) => void;
  groups: BoardGroup[];
}) {
  const patch = (p: Partial<BoardFilters>) => onChange({ ...filters, ...p });

  const groupOptions = [
    { value: "", label: "全部数据源" },
    ...groups.map((g) => ({ value: String(g.id), label: g.name })),
  ];

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-ink-700 bg-ink-900/60 px-3 py-2">
      <Select
        label="数据源"
        value={filters.groupId != null ? String(filters.groupId) : ""}
        options={groupOptions}
        onChange={(v) => patch({ groupId: v ? Number(v) : undefined })}
      />

      <Segmented
        options={WINDOWS}
        value={(filters.window ?? "d30") as Win}
        onChange={(w) => patch({ window: w })}
      />

      {filters.window === "custom" && (
        <div className="flex items-center gap-1.5">
          <input
            type="date"
            value={filters.dateFrom ?? ""}
            max={filters.dateTo || undefined}
            onChange={(e) => patch({ dateFrom: e.target.value })}
            className="rounded-lg border border-ink-700 bg-ink-900 px-2 py-1 text-xs text-zinc-200"
          />
          <span className="text-zinc-600">→</span>
          <input
            type="date"
            value={filters.dateTo ?? ""}
            min={filters.dateFrom || undefined}
            onChange={(e) => patch({ dateTo: e.target.value })}
            className="rounded-lg border border-ink-700 bg-ink-900 px-2 py-1 text-xs text-zinc-200"
          />
        </div>
      )}

      <span className="mx-1 h-4 w-px bg-ink-700" />

      <Segmented options={GRANS} value={filters.granularity} onChange={(g) => patch({ granularity: g })} />
    </div>
  );
}
