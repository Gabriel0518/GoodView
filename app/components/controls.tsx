import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/util";

// 点击外部关闭的弹出层
export function Popover({
  trigger,
  children,
  align = "left",
  width = "w-72",
}: {
  trigger: (open: boolean) => React.ReactNode;
  children: (close: () => void) => React.ReactNode;
  align?: "left" | "right";
  width?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className="relative inline-block" ref={ref}>
      <button onClick={() => setOpen((v) => !v)}>{trigger(open)}</button>
      {open && (
        <div className={cn("absolute z-30 mt-1 rounded-xl border border-ink-700 bg-ink-850 p-2 shadow-xl", width, align === "right" ? "right-0" : "left-0")}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

const triggerCls =
  "flex items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-850 px-3 py-1.5 text-xs text-zinc-200 hover:border-ink-600";

// 多选下拉（可搜索）
export function MultiSelect({
  label,
  options,
  selected,
  onChange,
  searchable = true,
  emptyLabel = "全部",
}: {
  label: string;
  options: { value: string; label: string; hint?: string }[];
  selected: string[];
  onChange: (v: string[]) => void;
  searchable?: boolean;
  emptyLabel?: string;
}) {
  const [q, setQ] = useState("");
  const sel = new Set(selected);
  const filtered = options.filter((o) => !q || o.label.toLowerCase().includes(q.toLowerCase()) || o.hint?.toLowerCase().includes(q.toLowerCase()));
  const toggle = (v: string) => onChange(sel.has(v) ? selected.filter((x) => x !== v) : [...selected, v]);

  return (
    <Popover
      width="w-80"
      trigger={() => (
        <span className={triggerCls}>
          <span className="text-zinc-500">{label}</span>
          <span className="font-medium">{selected.length ? `${selected.length} 项` : emptyLabel}</span>
          <span className="text-zinc-600">▾</span>
        </span>
      )}
    >
      {() => (
        <div>
          {searchable && (
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索…"
              className="mb-2 w-full rounded-lg border border-ink-700 bg-ink-900 px-2 py-1.5 text-xs text-zinc-200 outline-none focus:border-accent"
            />
          )}
          <div className="mb-2 flex items-center justify-between text-xs">
            <button className="text-accent-soft hover:underline" onClick={() => onChange(options.map((o) => o.value))}>全选</button>
            <span className="text-zinc-600">{selected.length}/{options.length}</span>
            <button className="text-zinc-400 hover:underline" onClick={() => onChange([])}>清空</button>
          </div>
          <div className="max-h-64 space-y-0.5 overflow-y-auto">
            {filtered.map((o) => (
              <label key={o.value} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-ink-800">
                <input type="checkbox" checked={sel.has(o.value)} onChange={() => toggle(o.value)} className="accent-accent" />
                <span className="flex-1 truncate text-zinc-200" title={o.label}>{o.label}</span>
                {o.hint && <span className="shrink-0 text-[10px] text-zinc-600">{o.hint}</span>}
              </label>
            ))}
            {!filtered.length && <div className="px-2 py-3 text-center text-xs text-zinc-600">无匹配</div>}
          </div>
        </div>
      )}
    </Popover>
  );
}

// 单选下拉
export function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string; disabled?: boolean }[];
  onChange: (v: string) => void;
}) {
  const cur = options.find((o) => o.value === value);
  return (
    <Popover
      width="w-56"
      trigger={() => (
        <span className={triggerCls}>
          <span className="text-zinc-500">{label}</span>
          <span className="font-medium">{cur?.label ?? value}</span>
          <span className="text-zinc-600">▾</span>
        </span>
      )}
    >
      {(close) => (
        <div className="space-y-0.5">
          {options.map((o) => (
            <button
              key={o.value}
              disabled={o.disabled}
              onClick={() => { if (!o.disabled) { onChange(o.value); close(); } }}
              className={cn(
                "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs",
                o.value === value ? "bg-accent/20 text-accent-soft" : "text-zinc-200 hover:bg-ink-800",
                o.disabled && "cursor-not-allowed text-zinc-600",
              )}
            >
              <span className="truncate">{o.label}</span>
              {o.disabled && <span className="text-[10px] text-zinc-600">待补充</span>}
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}

// 弹出式日期范围选择（含快捷预设）
export function DateRangePicker({
  min,
  max,
  from,
  to,
  onChange,
}: {
  min: string;
  max: string;
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
}) {
  const shift = (days: number) => {
    // 从 max 往前 days 天
    const d = new Date(max + "T00:00:00");
    d.setDate(d.getDate() - (days - 1));
    const f = d.toISOString().slice(0, 10);
    onChange(f < min ? min : f, max);
  };
  const presets = [
    { label: "最近 7 天", days: 7 },
    { label: "最近 14 天", days: 14 },
    { label: "最近 30 天", days: 30 },
  ];

  return (
    <Popover
      align="right"
      width="w-72"
      trigger={() => (
        <span className={triggerCls}>
          <span className="text-zinc-500">日期</span>
          <span className="tnum font-medium">{from} → {to}</span>
          <span className="text-zinc-600">▾</span>
        </span>
      )}
    >
      {(close) => (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1">
            {presets.map((p) => (
              <button key={p.days} onClick={() => shift(p.days)} className="rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-xs text-zinc-300 hover:border-accent">
                {p.label}
              </button>
            ))}
            <button onClick={() => onChange(min, max)} className="rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-xs text-zinc-300 hover:border-accent">全部</button>
          </div>
          <div className="flex items-center gap-2">
            <input type="date" value={from} min={min} max={to} onChange={(e) => onChange(e.target.value, to)} className="w-full rounded-lg border border-ink-700 bg-ink-900 px-2 py-1 text-xs text-zinc-200" />
            <span className="text-zinc-600">→</span>
            <input type="date" value={to} min={from} max={max} onChange={(e) => onChange(from, e.target.value)} className="w-full rounded-lg border border-ink-700 bg-ink-900 px-2 py-1 text-xs text-zinc-200" />
          </div>
          <button onClick={close} className="w-full rounded-lg bg-accent py-1.5 text-xs font-medium text-white hover:bg-accent-soft">完成</button>
        </div>
      )}
    </Popover>
  );
}
