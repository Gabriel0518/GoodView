"use client";

// 步骤 1：选度量。按 MEASURE_GROUPS 分组展示；选中后展示口径标注（note）。
import { MEASURES, MEASURE_GROUPS, getMeasure } from "../../lib/metrics";
import { cn } from "../../lib/util";

export function MeasurePicker({ value, onChange }: { value: string; onChange: (key: string) => void }) {
  const selected = value ? getMeasure(value) : undefined;
  return (
    <div className="space-y-3">
      {MEASURE_GROUPS.map((group) => {
        const ms = MEASURES.filter((m) => m.group === group);
        if (!ms.length) return null;
        return (
          <div key={group}>
            <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-600">{group}</div>
            <div className="flex flex-wrap gap-1.5">
              {ms.map((m) => (
                <button
                  key={m.key}
                  onClick={() => onChange(m.key)}
                  title={m.note}
                  className={cn(
                    "rounded-lg border px-2.5 py-1.5 text-xs transition",
                    value === m.key
                      ? "border-accent bg-accent/20 text-accent-soft"
                      : "border-ink-700 bg-ink-850 text-zinc-300 hover:border-ink-600 hover:text-zinc-100",
                  )}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
        );
      })}
      {selected?.note && (
        <p className="rounded-lg border border-ink-700 bg-ink-900/60 px-3 py-2 text-[11px] leading-snug text-zinc-500">
          ⓘ {selected.note}
        </p>
      )}
    </div>
  );
}
