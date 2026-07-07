"use client";

// 事件配置（原 /admin/events, UI-设计需求.md §5-E）：增改 BytePlus 打点事件（漏斗阶段）。
// 改动写 funnel_stage_meta，下次 cron 拉取按新定义取数。浅色 SaaS 风。
import { useCallback, useEffect, useState } from "react";
import { Panel, Button, Badge } from "../ui";
import { cn } from "../../lib/util";

type EventFilter = { property: string; values: string[] };
type StageEvent = {
  stage_key: string;
  ord: number;
  label: string;
  event_name: string;
  filters: EventFilter[] | null;
  enabled: boolean;
  source_split: boolean;
  indicator: string;
  status: string | null;
};

type Draft = {
  stage_key: string;
  label: string;
  event_name: string;
  ord: number | "";
  filterProperty: string;
  filterValues: string;
  indicator: string;
  enabled: boolean;
  source_split: boolean;
  isNew: boolean;
};

const emptyDraft = (): Draft => ({
  stage_key: "", label: "", event_name: "", ord: "",
  filterProperty: "", filterValues: "", indicator: "event_users",
  enabled: true, source_split: true, isNew: true,
});

function toDraft(e: StageEvent): Draft {
  const f = e.filters?.[0];
  return {
    stage_key: e.stage_key, label: e.label, event_name: e.event_name, ord: e.ord,
    filterProperty: f?.property || "", filterValues: (f?.values || []).join(", "),
    indicator: e.indicator, enabled: e.enabled, source_split: e.source_split, isNew: false,
  };
}

export function EventsManager() {
  const [events, setEvents] = useState<StageEvent[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const r = await fetch("/api/events", { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setEvents(Array.isArray(j) ? j : []);
    } catch (e) {
      setErr(String((e as Error)?.message || e));
      setEvents([]);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const draftToBody = (d: Draft) => ({
    stage_key: d.stage_key.trim(),
    label: d.label.trim(),
    event_name: d.event_name.trim(),
    ord: d.ord === "" ? undefined : Number(d.ord),
    filters: d.filterProperty.trim()
      ? [{ property: d.filterProperty.trim(), values: d.filterValues.split(",").map((s) => s.trim()).filter(Boolean) }]
      : null,
    indicator: d.indicator.trim() || "event_users",
    enabled: d.enabled,
    source_split: d.source_split,
  });

  const save = async () => {
    if (!draft) return;
    if (!draft.stage_key.trim() || !draft.label.trim() || !draft.event_name.trim()) {
      setErr("stage_key / 显示名 / event_name 必填");
      return;
    }
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/events", {
        method: draft.isNew ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draftToBody(draft)),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setDraft(null);
      await load();
    } catch (e) {
      setErr(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  };

  // 行内切换 enabled / source_split（乐观更新 + PUT）
  const toggle = async (e: StageEvent, field: "enabled" | "source_split") => {
    const next = !e[field];
    setEvents((es) => es?.map((x) => (x.stage_key === e.stage_key ? { ...x, [field]: next } : x)) ?? null);
    try {
      const r = await fetch("/api/events", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage_key: e.stage_key, [field]: next }),
      });
      if (!r.ok) throw new Error((await r.json()).error || `HTTP ${r.status}`);
    } catch (err) {
      setErr(String((err as Error)?.message || err));
      await load();
    }
  };

  const remove = async (e: StageEvent) => {
    if (!window.confirm(`删除事件「${e.label}」(${e.stage_key})？其漏斗历史数据将一并删除，不可撤销。`)) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/events?stage_key=${encodeURIComponent(e.stage_key)}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json()).error || `HTTP ${r.status}`);
      await load();
    } catch (err) {
      setErr(String((err as Error)?.message || err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-strong">事件配置</h1>
          <p className="mt-1 text-xs text-muted">增改 BytePlus 打点事件（漏斗阶段）；改动写入 funnel_stage_meta，下次拉取(每5分钟)按新定义取数。</p>
        </div>
        <Button variant="primary" onClick={() => setDraft(emptyDraft())}>+ 新增事件</Button>
      </div>

      <div className="rounded-lg border border-info/30 bg-info-soft px-4 py-2.5 text-xs text-info">
        提示：停用的事件下次拉取跳过；「按 source 拆」关闭则只存日总额到 unknown。改 event_name/过滤影响取数口径，请谨慎。
      </div>

      {err && <div className="rounded-xl border border-danger/30 bg-danger-soft px-4 py-3 text-xs text-danger">{err}</div>}

      <Panel title="全部事件" subtitle={events ? `${events.length} 个阶段` : "加载中…"} action={<Button variant="ghost" onClick={load}>刷新</Button>}>
        {!events ? (
          <div className="py-10 text-center text-xs text-muted">加载中…</div>
        ) : events.length === 0 ? (
          <div className="py-10 text-center text-xs text-muted">还没有事件。</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-subtle text-muted">
                  <th className="px-2 py-2 text-left font-medium">#</th>
                  <th className="px-2 py-2 text-left font-medium">显示名</th>
                  <th className="px-2 py-2 text-left font-medium">event_name</th>
                  <th className="px-2 py-2 text-left font-medium">过滤</th>
                  <th className="px-2 py-2 text-center font-medium">按 source 拆</th>
                  <th className="px-2 py-2 text-center font-medium">启用</th>
                  <th className="px-2 py-2 text-left font-medium">状态</th>
                  <th className="px-2 py-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.stage_key} className="border-b border-border-hair hover:bg-subtle">
                    <td className="tnum px-2 py-2 text-faint">{e.ord}</td>
                    <td className="px-2 py-2 font-medium text-strong">{e.label}</td>
                    <td className="px-2 py-2 font-mono text-[11px] text-body">{e.event_name}</td>
                    <td className="px-2 py-2 text-muted">
                      {e.filters?.[0] ? `${e.filters[0].property}=${e.filters[0].values.join("|")}` : "—"}
                    </td>
                    <td className="px-2 py-2 text-center">
                      <Toggle on={e.source_split} onClick={() => toggle(e, "source_split")} />
                    </td>
                    <td className="px-2 py-2 text-center">
                      <Toggle on={e.enabled} onClick={() => toggle(e, "enabled")} />
                    </td>
                    <td className="px-2 py-2">
                      {e.status ? (
                        <Badge tone={e.status.startsWith("失败") ? "danger" : "success"}>{e.status}</Badge>
                      ) : (
                        <span className="text-faint">—</span>
                      )}
                    </td>
                    <td className="px-2 py-2 text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" onClick={() => setDraft(toDraft(e))}>编辑</Button>
                        <Button variant="ghost" onClick={() => remove(e)} disabled={busy}>删除</Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {draft && (
        <EventEditor
          draft={draft}
          setDraft={setDraft}
          onSave={save}
          onCancel={() => { setDraft(null); setErr(null); }}
          busy={busy}
        />
      )}
    </div>
  );
}

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn("relative inline-flex h-5 w-9 items-center rounded-full transition", on ? "bg-accent" : "bg-subtle border border-border")}
      title={on ? "开" : "关"}
    >
      <span className={cn("inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-sm transition", on ? "translate-x-4" : "translate-x-0.5")} />
    </button>
  );
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block">
      <div className="mb-1 text-xs font-medium text-body">{label}</div>
      {children}
      {hint && <div className="mt-1 text-[11px] text-faint">{hint}</div>}
    </label>
  );
}

const inputCls = "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-body outline-none placeholder:text-faint focus:border-accent focus:ring-2 focus:ring-accent/20";

function EventEditor({
  draft, setDraft, onSave, onCancel, busy,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  onSave: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-strong/40 p-4">
      <div className="w-full max-w-lg rounded-xl border border-border bg-surface p-5 shadow-md">
        <h2 className="text-[15px] font-semibold text-strong">{draft.isNew ? "新增事件" : `编辑「${draft.label}」`}</h2>
        <div className="mt-4 space-y-3">
          <Field label="stage_key" hint={draft.isNew ? "唯一标识，创建后不可改（如 lp_show）" : "不可修改"}>
            <input className={cn(inputCls, !draft.isNew && "opacity-60")} value={draft.stage_key} disabled={!draft.isNew}
              onChange={(e) => set({ stage_key: e.target.value })} placeholder="lp_show" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="显示名"><input className={inputCls} value={draft.label} onChange={(e) => set({ label: e.target.value })} placeholder="投广页曝光" /></Field>
            <Field label="漏斗顺序 ord" hint="留空=末尾"><input className={inputCls} type="number" value={draft.ord} onChange={(e) => set({ ord: e.target.value === "" ? "" : Number(e.target.value) })} /></Field>
          </div>
          <Field label="event_name" hint="BytePlus 打点事件名"><input className={cn(inputCls, "font-mono")} value={draft.event_name} onChange={(e) => set({ event_name: e.target.value })} placeholder="pwa_conv_lp_show" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="过滤属性" hint="可空；如 task_id"><input className={inputCls} value={draft.filterProperty} onChange={(e) => set({ filterProperty: e.target.value })} placeholder="task_id" /></Field>
            <Field label="过滤取值" hint="逗号分隔；如 110,112"><input className={inputCls} value={draft.filterValues} onChange={(e) => set({ filterValues: e.target.value })} placeholder="110" /></Field>
          </div>
          <Field label="indicator" hint="BytePlus event_indicator（去重人数 event_users）"><input className={inputCls} value={draft.indicator} onChange={(e) => set({ indicator: e.target.value })} /></Field>
          <div className="flex items-center gap-6">
            <label className="flex items-center gap-2 text-sm text-body"><input type="checkbox" className="accent-accent" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> 启用</label>
            <label className="flex items-center gap-2 text-sm text-body"><input type="checkbox" className="accent-accent" checked={draft.source_split} onChange={(e) => set({ source_split: e.target.checked })} /> 按 source 拆分</label>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="default" onClick={onCancel}>取消</Button>
          <Button variant="primary" onClick={onSave} disabled={busy}>{busy ? "保存中…" : "保存"}</Button>
        </div>
      </div>
    </div>
  );
}
