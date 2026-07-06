import { useMemo, useState } from "react";
import type { Snapshot, Funnel } from "../lib/data";
import { costBasis, srcName, SOURCE_TO_CHANNEL, CHANNEL_LABEL, SOURCES, type Sel, type SourceSel } from "../lib/compute";
import { usePersistedState } from "../lib/hooks";
import { fmtInt, fmtMoney, fmtPct, rate, toCSV, downloadCSV, cn } from "../lib/util";
import { Panel, StatCard, Button } from "./ui";
import { MultiSelect } from "./controls";
import { Sparkline } from "./charts";

const PRESET = ["install_success", "login_click", "task_ins_bind", "withdraw_first", "mock_result", "home_show"];

export default function DailyReport({ snapshot, funnel, sel, source, dates }: { snapshot: Snapshot; funnel: Funnel; sel: Sel; source: SourceSel; dates: string[] }) {
  const cur = snapshot.meta.currency || "USD";
  const [date, setDate] = useState(dates[dates.length - 1] || "");
  const [picked, setPicked] = usePersistedState<string[]>("dr.picked", () => {
    const pre = funnel.stages.filter((s) => PRESET.includes(s.key)).map((s) => s.key);
    return pre.length ? pre : funnel.stages.slice(0, 5).map((s) => s.key);
  });

  const di = funnel.dates.indexOf(date);
  const channel = source === "all" ? null : SOURCE_TO_CHANNEL[source];
  const basis = useMemo(() => costBasis(snapshot, { ...sel, from: date, to: date }, source), [snapshot, sel, date, source]);
  const noPaid = basis.noPaid;

  const sumAt = (st: Funnel["stages"][number], i: number) => {
    if (i < 0) return 0;
    const srcs = source === "all" ? [...SOURCES] : [source];
    return srcs.reduce((a, s) => a + (st.bySource[s]?.data[i] || 0), 0);
  };

  const igStage = funnel.stages.find((s) => s.key === "task_ins_bind"); // IG授权=绑定Ins完成(task_id=110)
  const igCount = igStage ? sumAt(igStage, di) : 0;

  const cards = useMemo(() => {
    const pickedSet = new Set(picked);
    return funnel.stages.filter((s) => pickedSet.has(s.key)).map((st) => {
      const count = sumAt(st, di);
      const prev = di > 0 ? sumAt(st, di - 1) : 0;
      const growth = di > 0 ? (prev ? (count - prev) / prev : count ? 1 : 0) : null;
      const start = Math.max(0, di - 13);
      const spark = di < 0 ? [] : funnel.dates.slice(start, di + 1).map((_, k) => sumAt(st, start + k));
      return { key: st.key, label: st.label, count, growth, price: noPaid || !count ? null : basis.cost / count, spark };
    });
  }, [funnel, picked, di, basis, noPaid, source]);

  const stageOpts = funnel.stages.map((s) => ({ value: s.key, label: s.label, hint: s.name }));
  const chLabel = basis.byCampaign ? "选中系列" : source === "all" ? "全渠道" : noPaid ? srcName(source) : CHANNEL_LABEL[channel!] || channel;

  const exportDay = () => {
    const meta: (string | number)[][] = [
      ["日期", date], ["来源", source === "all" ? "全部" : source],
      [`广告花费(${chLabel})`, basis.cost.toFixed(2)], ["曝光", basis.impression], ["点击", basis.click], ["IG授权", igCount],
    ];
    const rows = toCSV(["维度", "事件", "当日数", "单价", "环比"], cards.map((c) => [c.label, c.key, c.count, c.price === null ? "" : c.price.toFixed(2), c.growth === null ? "" : (c.growth * 100).toFixed(1) + "%"]));
    downloadCSV(`日报_${date}_${source}.csv`, toCSV(["项", "值"], meta) + "\n\n" + rows);
  };

  return (
    <div className="space-y-4">
      <Panel
        title="日报"
        subtitle={`来源 ${source === "all" ? "合计" : source} · ${chLabel} · 单价 = 当日${chLabel}花费 ÷ 该维度人数`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <MultiSelect label="维度" options={stageOpts} selected={picked} onChange={setPicked} emptyLabel="未选" />
            <input type="date" value={date} min={dates[0]} max={dates[dates.length - 1]} onChange={(e) => setDate(e.target.value)} className="rounded-lg border border-ink-700 bg-ink-850 px-2 py-1 text-xs text-zinc-200" />
            <Button onClick={exportDay}>导出</Button>
          </div>
        }
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label={`广告花费(${chLabel})`} value={noPaid ? "None" : fmtMoney(basis.cost, cur)} accent={!noPaid} />
          <StatCard label="曝光 / 点击" value={noPaid ? "None" : `${fmtInt(basis.impression)} / ${fmtInt(basis.click)}`} />
          <StatCard label={`IG授权(${source === "all" ? "全部" : source})`} value={fmtInt(igCount)} accent />
          <StatCard label="单IG授权成本" value={noPaid || !igCount ? "None" : fmtMoney(rate(basis.cost, igCount), cur)} />
        </div>
      </Panel>

      <Panel title="所选维度" subtitle={di < 0 ? "该日无漏斗数据" : `${date} · ${chLabel} · 环比 vs 前一日`}>
        {cards.length === 0 ? (
          <div className="py-6 text-center text-sm text-zinc-600">未选择维度，点右上角「维度」勾选。</div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {cards.map((c) => (
              <div key={c.key} className="rounded-xl border border-ink-700 bg-ink-850 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-xs text-zinc-400" title={c.label}>{c.label}</div>
                    <div className="tnum mt-0.5 text-xl font-semibold text-zinc-100">{fmtInt(c.count)}</div>
                  </div>
                  {c.growth !== null && (
                    <span className={cn("tnum shrink-0 rounded-md px-1.5 py-0.5 text-xs", c.growth >= 0 ? "bg-emerald-950/50 text-emerald-400" : "bg-rose-950/50 text-rose-400")}>
                      {c.growth >= 0 ? "▲" : "▼"} {fmtPct(Math.abs(c.growth))}
                    </span>
                  )}
                </div>
                <div className="tnum mt-1 text-xs text-accent-soft">单价 {c.price === null ? "None" : fmtMoney(c.price, cur)}</div>
                <div className="mt-2 opacity-80">
                  <Sparkline values={c.spark} color={c.growth !== null && c.growth < 0 ? "#fb7185" : "#7c8cff"} />
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
