"use client";

// 引导式卡片搭建器：选度量 → 兼容维度（灰掉不兼容）→ 参数（stage / cvr）→ 图表 → 实时预览 → 保存。
// 走 /api/query 实时预览（唯一数据路径）。保存产出 { title, config }，由看板页 POST/PUT。
import { useEffect, useMemo, useState } from "react";
import type { DimKey, VizType } from "../../lib/metrics";
import { getMeasure } from "../../lib/metrics";
import type { QueryRequest, QueryParams } from "../../lib/query-types";
import type { BoardFilters, CardConfig } from "../board/types";
import { mergeFilters } from "../board/types";
import { useQuery } from "../board/useQuery";
import { Select } from "../controls";
import { Button, Panel } from "../ui";
import { VizRenderer } from "../viz/VizRenderer";
import { MeasurePicker } from "./MeasurePicker";
import { DimPicker } from "./DimPicker";
import { VizPicker, vizAvailability } from "./VizPicker";
import { useStages } from "./useStages";

export function CardBuilder({
  boardFilters,
  initial,
  onSave,
  onCancel,
}: {
  boardFilters: BoardFilters;
  initial?: { title: string; config: CardConfig };
  onSave: (title: string, config: CardConfig) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [measure, setMeasure] = useState(initial?.config.measure ?? "");
  const [dims, setDims] = useState<DimKey[]>(initial?.config.dims ?? []);
  const [viz, setViz] = useState<VizType | null>(initial?.config.viz ?? null);
  const [stage, setStage] = useState(initial?.config.params?.stage ?? "");
  const [cvrFrom, setCvrFrom] = useState(initial?.config.params?.cvrFrom ?? "");
  const [cvrTo, setCvrTo] = useState(initial?.config.params?.cvrTo ?? "");
  const [saving, setSaving] = useState(false);

  const m = measure ? getMeasure(measure) : undefined;
  const { stages, loading: stagesLoading } = useStages();
  const stageOptions = useMemo(() => stages.map((s) => ({ value: s.stage_key, label: s.label })), [stages]);

  // 换度量 → 清维度/图表/参数（兼容集变了）
  const pickMeasure = (key: string) => {
    if (key === measure) return;
    setMeasure(key);
    setDims([]);
    setViz(null);
    setStage("");
    setCvrFrom("");
    setCvrTo("");
    if (!title.trim()) setTitle(getMeasure(key)?.label ?? "");
  };

  // 维度变化后，若当前图表不再合法 → 自动切到首个可用图表。
  // 用函数式 setViz 读当前值，避免把 viz 列入依赖（否则会覆盖用户手选）。
  useEffect(() => {
    if (!measure) return;
    const order: VizType[] = ["number", "line", "bar", "table", "funnel"];
    setViz((cur) => {
      if (cur && vizAvailability(cur, dims).ok) return cur;
      return order.find((v) => vizAvailability(v, dims).ok) ?? null;
    });
  }, [dims, measure]);

  // 参数完备性
  const paramsOk = !m ? false : m.needsStage ? !!stage : m.needsCvr ? !!cvrFrom && !!cvrTo : true;
  const vizOk = !!viz && vizAvailability(viz, dims).ok;
  const canSave = !!measure && vizOk && paramsOk && !saving;

  // 组装参数
  const params = useMemo<QueryParams | undefined>(() => {
    if (!m) return undefined;
    if (m.needsStage) return { stage };
    if (m.needsCvr) return { cvrFrom, cvrTo };
    return undefined;
  }, [m, stage, cvrFrom, cvrTo]);

  // 预览请求（完备时才发）
  const previewReq: QueryRequest | null = useMemo(() => {
    if (!measure || !vizOk || !paramsOk) return null;
    return { measure, params, dims, filters: mergeFilters(boardFilters, initial?.config.cardFilters) };
  }, [measure, vizOk, paramsOk, params, dims, boardFilters, initial]);

  const { rows, meta, loading, error } = useQuery(previewReq);

  const buildConfig = (): CardConfig => ({
    measure,
    params,
    dims,
    viz: viz as VizType,
    cardFilters: initial?.config.cardFilters,
  });

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await onSave(title.trim() || m?.label || "新卡片", buildConfig());
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={onCancel}>
      <div
        className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-ink-700 bg-ink-950 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* 头 */}
        <div className="flex items-center justify-between gap-3 border-b border-ink-700 px-5 py-3">
          <h2 className="text-sm font-semibold text-zinc-100">{initial ? "编辑卡片" : "新建卡片"}</h2>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onCancel}>
              取消
            </Button>
            <Button variant="primary" onClick={save} disabled={!canSave}>
              {saving ? "保存中…" : "保存卡片"}
            </Button>
          </div>
        </div>

        {/* 体：左配置 / 右预览 */}
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 overflow-hidden md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          {/* 左：引导配置 */}
          <div className="min-h-0 space-y-4 overflow-y-auto border-r border-ink-700 p-5">
            <Field label="标题">
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="卡片标题"
                className="w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-accent"
              />
            </Field>

            <Field label="① 度量">
              <MeasurePicker value={measure} onChange={pickMeasure} />
            </Field>

            {m && (m.needsStage || m.needsCvr) && (
              <Field label="② 参数">
                {stagesLoading ? (
                  <p className="text-[11px] text-zinc-600">加载阶段列表…</p>
                ) : stageOptions.length === 0 ? (
                  <p className="text-[11px] text-amber-400/80">阶段列表未就绪（/api/meta/stages）。后端就绪后可选。</p>
                ) : m.needsStage ? (
                  <Select label="阶段" value={stage} options={stageOptions} onChange={setStage} />
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <Select label="起始阶段" value={cvrFrom} options={stageOptions} onChange={setCvrFrom} />
                    <span className="text-zinc-600">→</span>
                    <Select label="目标阶段" value={cvrTo} options={stageOptions} onChange={setCvrTo} />
                  </div>
                )}
              </Field>
            )}

            <Field label={`${m && (m.needsStage || m.needsCvr) ? "③" : "②"} 维度（X / 序列 / Z）`}>
              {measure ? (
                <DimPicker measure={measure} dims={dims} onChange={setDims} maxDims={3} />
              ) : (
                <p className="text-[11px] text-zinc-600">请先选择度量</p>
              )}
            </Field>

            <Field label={`${m && (m.needsStage || m.needsCvr) ? "④" : "③"} 图表`}>
              {measure ? (
                <VizPicker dims={dims} value={viz} onChange={setViz} />
              ) : (
                <p className="text-[11px] text-zinc-600">请先选择度量</p>
              )}
            </Field>
          </div>

          {/* 右：实时预览 */}
          <div className="min-h-0 overflow-y-auto bg-ink-900/40 p-5">
            <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-zinc-600">预览</div>
            <Panel className="min-h-[260px]">
              {!measure || !vizOk || !paramsOk ? (
                <div className="py-12 text-center text-xs text-zinc-600">
                  {!measure
                    ? "选择度量开始搭建"
                    : !paramsOk
                      ? "补全参数后预览"
                      : "选择合法的维度与图表后预览"}
                </div>
              ) : (
                <VizRenderer viz={viz as VizType} rows={rows} meta={meta} loading={loading} error={error} note={m?.note} />
              )}
            </Panel>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-xs font-medium text-zinc-400">{label}</div>
      {children}
    </div>
  );
}
