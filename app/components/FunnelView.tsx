import { useMemo } from "react";
import type { Funnel, Snapshot } from "../lib/data";
import { costBasis, srcName, SOURCE_TO_CHANNEL, CHANNEL_LABEL, SOURCES, type Sel, type SourceSel } from "../lib/compute";
import { usePersistedState } from "../lib/hooks";
import { fmtInt, fmtMoney, fmtPct, rate, toCSV, downloadCSV, cn } from "../lib/util";
import { Panel, Button } from "./ui";
import { MultiSelect } from "./controls";

export default function FunnelView({ funnel, snapshot, sel, source }: { funnel: Funnel; snapshot: Snapshot; sel: Sel; source: SourceSel }) {
  const cur = snapshot.meta.currency || "USD";
  const [picked, setPicked] = usePersistedState<string[]>("fn.picked", funnel.stages.map((s) => s.key));

  const idx = useMemo(() => funnel.dates.map((d, i) => (d >= sel.from && d <= sel.to ? i : -1)).filter((i) => i >= 0), [funnel, sel]);
  const basis = useMemo(() => costBasis(snapshot, sel, source), [snapshot, sel, source]);
  const noPaid = basis.noPaid;
  const basisSpend = basis.cost;
  const channel = source === "all" ? null : SOURCE_TO_CHANNEL[source];

  const stageVal = (stage: Funnel["stages"][number], src: SourceSel) => {
    const srcs = src === "all" ? [...SOURCES] : [src];
    let sum = 0;
    for (const s of srcs) {
      const arr = stage.bySource[s]?.data || [];
      for (const i of idx) sum += arr[i] || 0;
    }
    return sum;
  };

  const pickedSet = new Set(picked);
  const shownStages = funnel.stages.filter((s) => pickedSet.has(s.key));

  const rows = useMemo(() => {
    const vals = shownStages.map((st) => ({ st, v: stageVal(st, source) }));
    const max = Math.max(1, ...vals.map((x) => x.v));
    return vals.map((x, i) => ({
      key: x.st.key, label: x.st.label, value: x.v, width: x.v / max,
      cost: noPaid || !x.v ? null : basisSpend / x.v,
      stepConv: i === 0 ? null : rate(x.v, vals[i - 1].v),
    }));
  }, [shownStages, source, idx, basisSpend, noPaid]);

  const stageOpts = funnel.stages.map((s) => ({ value: s.key, label: s.label, hint: s.name }));
  const basisLabel = basis.byCampaign ? `选中系列花费 ${fmtMoney(basisSpend, cur)}` : noPaid ? "自然流量·无广告花费" : source === "all" ? `全渠道花费 ${fmtMoney(basisSpend, cur)}` : `${CHANNEL_LABEL[channel!] || channel} 花费 ${fmtMoney(basisSpend, cur)}`;

  const exportCSV = () => {
    const headers = ["#", "阶段", "事件", "人数", "单步成本", ...SOURCES];
    const data = shownStages.map((st, i) => {
      const v = stageVal(st, source);
      return [i + 1, st.label, st.name, v, noPaid || !v ? "" : (basisSpend / v).toFixed(2), ...SOURCES.map((s) => stageVal(st, s))];
    });
    downloadCSV(`转化漏斗_${source}_${sel.from}_${sel.to}.csv`, toCSV(headers, data));
  };

  return (
    <Panel
      title="转化漏斗"
      subtitle={`来源 ${srcName(source)} · ${shownStages.length}/${funnel.stages.length} 阶段 · ${basisLabel}`}
      action={
        <div className="flex flex-wrap items-center gap-2">
          <MultiSelect label="阶段" options={stageOpts} selected={picked} onChange={setPicked} emptyLabel="未选" />
          <Button onClick={exportCSV}>导出</Button>
        </div>
      }
    >
      {shownStages.length === 0 ? (
        <div className="py-8 text-center text-sm text-zinc-600">未选择阶段，点右上角「阶段」勾选。</div>
      ) : (
        <>
          <div className="mb-1 grid grid-cols-[1.6rem_10rem_1fr_4.5rem_5.5rem_4rem] items-center gap-2 px-1 text-[11px] text-zinc-600">
            <span /><span>阶段</span><span /><span className="text-right">人数</span><span className="text-right">单步成本</span><span className="text-right">转化</span>
          </div>
          <div className="space-y-1">
            {rows.map((r, i) => (
              <div key={r.key} className="grid grid-cols-[1.6rem_10rem_1fr_4.5rem_5.5rem_4rem] items-center gap-2 rounded-md px-1 py-1 hover:bg-ink-800/50">
                <span className="tnum text-right text-xs text-zinc-600">{i + 1}</span>
                <span className="truncate text-xs text-zinc-300" title={r.label}>{r.label}</span>
                <div className="h-5 overflow-hidden rounded bg-ink-850">
                  <div className="h-full rounded bg-gradient-to-r from-accent/70 to-accent" style={{ width: `${Math.max(r.width * 100, r.value ? 1.5 : 0)}%` }} />
                </div>
                <span className="tnum text-right text-xs text-zinc-200">{fmtInt(r.value)}</span>
                <span className="tnum text-right text-xs text-accent-soft">{r.cost === null ? "None" : fmtMoney(r.cost, cur)}</span>
                <span className={cn("tnum text-right text-xs", r.stepConv === null ? "text-zinc-600" : r.stepConv >= 0.6 ? "text-emerald-400" : r.stepConv >= 0.3 ? "text-amber-400" : "text-rose-400")} title="相对上一个所选阶段的转化率">
                  {r.stepConv === null ? "—" : fmtPct(r.stepConv)}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
      <p className="mt-3 text-xs text-zinc-600">
        单步成本 = 成本基准 ÷ 该步人数。注意口径：① 人数为窗口内独立 UV（非同期群），存量用户只走后段会把转化率推高至超过 100%；② 流程中 0.5刀首笔提现在 IG授权之前；③ 「不明来源」= 无 source 值的用户（全量 − 4已知源），合计=真实全量。
      </p>
    </Panel>
  );
}
