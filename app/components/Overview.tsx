import { useMemo } from "react";
import type { Snapshot, Funnel } from "../lib/data";
import {
  channelBreakdown, costBasis, dailySpend, spendByChannel, srcName,
  SOURCES, SOURCE_TO_CHANNEL, CHANNEL_LABEL, type Sel, type SourceSel,
} from "../lib/compute";
import { usePersistedState } from "../lib/hooks";
import { fmtInt, fmtMoney, fmtNum, fmtPct, rate } from "../lib/util";
import { toCSV, downloadCSV } from "../lib/util";
import { Panel, StatCard, Button } from "./ui";
import { MultiSelect } from "./controls";
import { LineChart } from "./charts";

type Fmt = "money" | "int" | "pct";
type Def = { key: string; label: string; group: string; fmt: Fmt; accent?: boolean; prov: string | null; v: () => number | null };

// IG授权口径 = 绑定Ins任务完成（pwa_task_complete task_id=110）。非按钮点击(ins_auth_click)。
const IG_STAGE = "task_ins_bind";

const DEFAULT_CARDS = ["cost", "click", "c_install", "c_ig", "cost_ig", "c_withdraw", "cost_withdraw", "r_login_ig"];

export default function Overview({ snapshot, funnel, sel, source }: { snapshot: Snapshot; funnel: Funnel | null; sel: Sel; source: SourceSel }) {
  const cur = snapshot.meta.currency || "USD";
  const [cards, setCards] = usePersistedState<string[]>("ov.cards", DEFAULT_CARDS);
  const { from, to } = sel;

  const channel = source === "all" ? null : SOURCE_TO_CHANNEL[source]; // 仅用于趋势/标签

  // 成本基准：选了账户/系列 → 用选中广告花费；否则渠道口径
  const basis = useMemo(() => costBasis(snapshot, sel, source), [snapshot, sel, source]);
  const stat = basis;
  const noPaid = basis.noPaid;

  // 按来源的漏斗阶段人数
  const idx = useMemo(() => (funnel ? funnel.dates.map((d, i) => (d >= from && d <= to ? i : -1)).filter((i) => i >= 0) : []), [funnel, from, to]);
  const cnt = (key: string) => {
    if (!funnel) return 0;
    const st = funnel.stages.find((s) => s.key === key);
    if (!st) return 0;
    const srcs = source === "all" ? [...SOURCES] : [source];
    return idx.reduce((a, i) => a + srcs.reduce((b, s) => b + (st.bySource[s]?.data[i] || 0), 0), 0);
  };

  // 每个维度的数据口径：
  //  - 花费/流量：选了系列 → 选中系列的 XMP 直接数据；未选 → 渠道口径(fb/tt)；bff/AIguild 未选系列时无花费数据 → None
  //  - 人数：BytePlus 按来源直接数据（注意：未按系列归因，系列筛选不影响人数）
  //  - 单位成本/含点击的转化率：花费侧 ÷ 人数侧，跨系统测算；花费侧为 None 或分母为 0 时 → None
  const spendProv = basis.byCampaign
    ? "选中系列 · XMP直接"
    : noPaid
      ? null
      : source === "all" ? "全渠道 · XMP直接" : `${CHANNEL_LABEL[channel!]}渠道 · XMP直接`;
  const countProv = `${srcName(source) === "合计" ? "全部来源" : srcName(source)} · BytePlus直接${(sel.accounts.length || sel.campaigns.length) ? "（未按系列归因）" : ""}`;
  const unitProv = spendProv ? `${basis.byCampaign ? "系列花费" : "渠道花费"}÷来源人数 · 测算` : null;
  const rateProv = "BytePlus直接 · 同来源";
  const xRateProv = spendProv ? `${basis.byCampaign ? "系列" : "渠道"}点击↔来源人数 · 测算` : null;

  const div = (n: number, d: number) => (d ? n / d : null); // 分母为 0 → None

  const DEFS: Def[] = [
    { key: "cost", label: "广告花费", group: "花费/流量", fmt: "money", accent: true, prov: spendProv, v: () => (spendProv ? stat.cost : null) },
    { key: "impression", label: "曝光", group: "花费/流量", fmt: "int", prov: spendProv, v: () => (spendProv ? stat.impression : null) },
    { key: "click", label: "点击", group: "花费/流量", fmt: "int", prov: spendProv, v: () => (spendProv ? stat.click : null) },
    { key: "cpm", label: "CPM", group: "花费/流量", fmt: "money", prov: spendProv, v: () => (spendProv ? div(stat.cost * 1000, stat.impression) : null) },
    { key: "ctr", label: "CTR", group: "花费/流量", fmt: "pct", prov: spendProv, v: () => (spendProv ? div(stat.click, stat.impression) : null) },
    { key: "cpc", label: "CPC", group: "花费/流量", fmt: "money", prov: spendProv, v: () => (spendProv ? div(stat.cost, stat.click) : null) },

    { key: "c_reach", label: "触达(投广页曝光)", group: "人数", fmt: "int", prov: countProv, v: () => cnt("lp_show") },
    { key: "c_install", label: "安装成功", group: "人数", fmt: "int", prov: countProv, v: () => cnt("install_success") },
    { key: "c_login", label: "谷歌登录", group: "人数", fmt: "int", prov: countProv, v: () => cnt("login_click") },
    { key: "c_onboard", label: "完成引导(电话确认)", group: "人数", fmt: "int", prov: countProv, v: () => cnt("phone_confirm") },
    { key: "c_ig", label: "IG授权(绑定完成)", group: "人数", fmt: "int", accent: true, prov: countProv, v: () => cnt(IG_STAGE) },
    { key: "c_mock", label: "mock通过", group: "人数", fmt: "int", prov: countProv, v: () => cnt("mock_result") },
    { key: "c_withdraw", label: "首笔提现", group: "人数", fmt: "int", accent: true, prov: countProv, v: () => cnt("withdraw_first") },

    { key: "cost_install", label: "单安装成本", group: "单位成本", fmt: "money", prov: unitProv, v: () => (unitProv ? div(stat.cost, cnt("install_success")) : null) },
    { key: "cost_login", label: "单登录成本", group: "单位成本", fmt: "money", prov: unitProv, v: () => (unitProv ? div(stat.cost, cnt("login_click")) : null) },
    { key: "cost_ig", label: "单IG授权成本", group: "单位成本", fmt: "money", accent: true, prov: unitProv, v: () => (unitProv ? div(stat.cost, cnt(IG_STAGE)) : null) },
    { key: "cost_mock", label: "单mock成本", group: "单位成本", fmt: "money", prov: unitProv, v: () => (unitProv ? div(stat.cost, cnt("mock_result")) : null) },
    { key: "cost_withdraw", label: "单首笔提现成本", group: "单位成本", fmt: "money", accent: true, prov: unitProv, v: () => (unitProv ? div(stat.cost, cnt("withdraw_first")) : null) },

    { key: "r_click_install", label: "点击→安装成功", group: "转化率", fmt: "pct", prov: xRateProv, v: () => (xRateProv ? div(cnt("install_success"), stat.click) : null) },
    { key: "r_install_loginpage", label: "安装成功→谷歌登录页", group: "转化率", fmt: "pct", prov: rateProv, v: () => div(cnt("login_page"), cnt("install_success")) },
    { key: "r_insshow_insclick", label: "Ins授权浮层曝光→点击", group: "转化率", fmt: "pct", prov: rateProv, v: () => div(cnt("ins_auth_click"), cnt("ins_auth_show")) },
  ];

  const fmtVal = (d: Def) => {
    const v = d.v();
    if (v === null) return "None";
    return d.fmt === "money" ? fmtMoney(v, cur) : d.fmt === "pct" ? fmtPct(v) : fmtInt(v);
  };
  const subOf = (d: Def) => (d.v() === null ? "无直接数据 · 无法测算" : d.prov ?? d.group);
  const opts = DEFS.map((d) => ({ value: d.key, label: d.label, hint: d.group }));
  const shown = DEFS.filter((d) => cards.includes(d.key));

  // 趋势（按来源）
  const dates = useMemo(() => (funnel ? funnel.dates.filter((d) => d >= from && d <= to) : []), [funnel, from, to]);
  const costByDate = useMemo(() => {
    const out: Record<string, number> = {};
    if (basis.byCampaign) {
      const bd = dailySpend(snapshot, sel);
      for (const d in bd) out[d] = bd[d].cost;
      return out;
    }
    const cr = snapshot.campaignRows;
    const rows = (cr?.length ? cr : snapshot.byChannelDate).filter((r) => r.date >= from && r.date <= to && (source === "all" || r.channel === channel));
    for (const r of rows) out[r.date] = (out[r.date] || 0) + r.cost;
    return out;
  }, [snapshot, sel, from, to, source, channel, basis.byCampaign]);
  const igByDate = useMemo(() => {
    const out: Record<string, number> = {};
    const st = funnel?.stages.find((s) => s.key === IG_STAGE);
    if (!funnel || !st) return out;
    const srcs = source === "all" ? [...SOURCES] : [source];
    funnel.dates.forEach((d, i) => { if (d >= from && d <= to) out[d] = srcs.reduce((a, s) => a + (st.bySource[s]?.data[i] || 0), 0); });
    return out;
  }, [funnel, from, to, source]);

  // 渠道级归因表（全渠道对比，不随 source 变）
  const attribution = useMemo(() => {
    if (!funnel) return null;
    const st = funnel.stages.find((s) => s.key === IG_STAGE);
    const ig = (src: string) => (st ? idx.reduce((a, i) => a + (st.bySource[src]?.data[i] || 0), 0) : 0);
    const chSpend = spendByChannel(snapshot, from, to);
    const rows = [
      { label: "Facebook", ch: "facebook", src: "fb" as string | null },
      { label: "TikTok", ch: "tiktok", src: "tt" as string | null },
      { label: "Google", ch: "google", src: null as string | null },
    ].map((r) => { const cost = chSpend[r.ch] || 0; const v = r.src ? ig(r.src) : null; return { ...r, cost, ig: v, cpa: v ? cost / v : null }; });
    return { rows, organicIg: ig("bff") + ig("AIguild") + ig("AIguild_active") + ig("AIguild_passive") + ig("unknown") };
  }, [funnel, snapshot, from, to, idx]);

  const channels = useMemo(
    () => channelBreakdown(snapshot, sel).map((c) => ({ ...c, cpm: rate(c.cost, c.impression) * 1000, ctr: rate(c.click, c.impression), cpc: rate(c.cost, c.click) })),
    [snapshot, sel],
  );

  const exportCards = () =>
    downloadCSV(`概览_${source}_${from}_${to}.csv`, toCSV(["维度", "组", "值", "口径"], DEFS.map((d) => {
      const v = d.v();
      return [d.label, d.group, v === null ? "None" : String(v), v === null ? "无直接数据·无法测算" : d.prov ?? ""];
    })));

  const srcLabel = source === "all" ? "全部来源" : srcName(source);
  const costCtx = basis.byCampaign ? "选中系列花费" : noPaid ? "无对应渠道花费(选系列可算)" : source === "all" ? "全渠道花费" : `${CHANNEL_LABEL[channel!]} 花费`;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-xs text-zinc-500">来源：{srcLabel} · 成本口径：{costCtx}</span>
        <div className="flex items-center gap-2">
          <Button onClick={exportCards} variant="ghost">导出全部维度</Button>
          <MultiSelect label="卡片维度" options={opts} selected={cards} onChange={setCards} emptyLabel="未选" />
        </div>
      </div>

      {shown.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {shown.map((d) => (
            <StatCard key={d.key} label={d.label} value={fmtVal(d)} sub={subOf(d)} accent={d.accent} />
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="广告花费趋势" subtitle={`按天 · ${costCtx}`}>
          <LineChart labels={dates} series={[{ name: "cost", color: "#7c8cff", values: dates.map((d) => costByDate[d] || 0) }]} valueFmt={(v) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(Math.round(v)))} />
        </Panel>
        <Panel title="IG授权趋势" subtitle={`按天 · ${srcLabel}`}>
          <LineChart labels={dates} series={[{ name: "ig", color: "#4ade80", values: dates.map((d) => igByDate[d] || 0) }]} />
        </Panel>
      </div>

      {attribution && (
        <Panel title="渠道级归因（全渠道对比）" subtitle="渠道花费 ÷ 对应 source 的 IG授权 = 单授权成本">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-700 text-left text-xs text-zinc-500">
                  <th className="py-2 pr-4 font-medium">渠道 (source)</th>
                  <th className="py-2 pr-4 text-right font-medium">花费</th>
                  <th className="py-2 pr-4 text-right font-medium">IG授权</th>
                  <th className="py-2 pr-0 text-right font-medium">单IG授权成本</th>
                </tr>
              </thead>
              <tbody className="tnum">
                {attribution.rows.map((r) => (
                  <tr key={r.ch} className="border-b border-ink-800/60">
                    <td className="py-2 pr-4 text-zinc-200">{r.label} <span className="text-xs text-zinc-600">{r.src ?? "无对应source"}</span></td>
                    <td className="py-2 pr-4 text-right">{fmtMoney(r.cost, cur)}</td>
                    <td className="py-2 pr-4 text-right">{r.ig === null ? "—" : fmtInt(r.ig)}</td>
                    <td className="py-2 pr-0 text-right text-accent-soft">{r.cpa === null ? "—" : fmtMoney(r.cpa, cur)}</td>
                  </tr>
                ))}
                <tr>
                  <td className="py-2 pr-4 text-zinc-400">其它/未归因 <span className="text-xs text-zinc-600">bff+公会+主动+被动+不明</span></td>
                  <td className="py-2 pr-4 text-right text-zinc-600">无花费</td>
                  <td className="py-2 pr-4 text-right">{fmtInt(attribution.organicIg)}</td>
                  <td className="py-2 pr-0 text-right text-zinc-600">—</td>
                </tr>
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      <Panel title="渠道明细（花费/流量）" subtitle={`${channels.length} 个渠道 · 受系列筛选影响`}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-700 text-left text-xs text-zinc-500">
                <th className="py-2 pr-4 font-medium">渠道</th>
                <th className="py-2 pr-4 text-right font-medium">花费</th>
                <th className="py-2 pr-4 text-right font-medium">曝光</th>
                <th className="py-2 pr-4 text-right font-medium">点击</th>
                <th className="py-2 pr-4 text-right font-medium">CPM</th>
                <th className="py-2 pr-4 text-right font-medium">CTR</th>
                <th className="py-2 pr-0 text-right font-medium">CPC</th>
              </tr>
            </thead>
            <tbody className="tnum">
              {channels.map((c) => (
                <tr key={c.channel} className="border-b border-ink-800/60">
                  <td className="py-2 pr-4 font-medium capitalize text-zinc-200">{c.channel}</td>
                  <td className="py-2 pr-4 text-right">{fmtMoney(c.cost, cur)}</td>
                  <td className="py-2 pr-4 text-right">{fmtInt(c.impression)}</td>
                  <td className="py-2 pr-4 text-right">{fmtInt(c.click)}</td>
                  <td className="py-2 pr-4 text-right">{fmtMoney(c.cpm, cur)}</td>
                  <td className="py-2 pr-4 text-right">{fmtPct(c.ctr)}</td>
                  <td className="py-2 pr-0 text-right">{fmtNum(c.cpc, 3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
