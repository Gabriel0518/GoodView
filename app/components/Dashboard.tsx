"use client";

import { useEffect, useMemo, useState } from "react";
import type { Snapshot, Funnel } from "../lib/data";
import type { Sel, SourceSel } from "../lib/compute";
import { accountOptions, campaignOptions, SOURCE_OPTIONS } from "../lib/compute";
import { usePersistedState } from "../lib/hooks";
import { Button, Segmented } from "./ui";
import { DateRangePicker, MultiSelect, Select } from "./controls";
import Overview from "./Overview";
import FunnelView from "./FunnelView";
import DailyReport from "./DailyReport";

type Tab = "overview" | "funnel" | "daily";

const APPS = [
  { value: "653834", label: "PWA · 653834" },
  { value: "_soon", label: "其它应用", disabled: true },
];

export default function Dashboard({ snapshot, funnel }: { snapshot: Snapshot | null; funnel: Funnel | null }) {
  const [tab, setTab] = usePersistedState<Tab>("ui.tab", "overview");
  const [source, setSource] = usePersistedState<SourceSel>("flt.source", "all");
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [appId, setAppId] = useState("653834");
  const [accounts, setAccounts] = useState<string[]>([]);
  const [campaigns, setCampaigns] = useState<string[]>([]);

  const allDates = useMemo(
    () => (snapshot?.byDate.map((d) => d.date) ?? funnel?.dates ?? []).slice().sort(),
    [snapshot, funnel],
  );
  const [from, setFrom] = useState(allDates[0] || "");
  const [to, setTo] = useState(allDates[allDates.length - 1] || "");

  const campaignRows = snapshot?.campaignRows ?? [];
  const hasCampaign = campaignRows.length > 0;
  const accountOpts = useMemo(() => accountOptions(campaignRows), [campaignRows]);
  const campaignOpts = useMemo(() => campaignOptions(campaignRows, accounts), [campaignRows, accounts]);

  const sel: Sel = { accounts, campaigns, from, to };
  const generatedAt = snapshot?.meta.generated_at || funnel?.meta.generated_at;

  // 后台每 5 分钟自动拉取；前端每 60s 轮询 /api/status，发现新数据即提示加载
  const [hasUpdate, setHasUpdate] = useState(false);
  useEffect(() => {
    const cur = generatedAt || "";
    const iv = setInterval(async () => {
      try {
        const r = await fetch("/api/status", { cache: "no-store" });
        const j = await r.json();
        const t = j.funnel_generated_at || j.snapshot_generated_at || "";
        if (t && cur && t > cur) setHasUpdate(true);
      } catch {
        /* 忽略轮询错误 */
      }
    }, 60000);
    return () => clearInterval(iv);
  }, [generatedAt]);

  const [notice, setNotice] = useState<string | null>(null);
  const refresh = async () => {
    setRefreshing(true);
    setErr(null);
    setNotice(null);
    try {
      const res = await fetch("/api/refresh", { method: "POST" });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "刷新失败");
      // 后台拉取已启动（2-3 分钟），靠轮询检测完成
      setNotice("已触发后台拉取，约 1–3 分钟后出现「有新数据」提示");
      setRefreshing(false);
    } catch (e: any) {
      setErr(String(e?.message || e));
      setRefreshing(false);
    }
  };

  if (!snapshot && !funnel) {
    return (
      <main className="mx-auto max-w-3xl p-10">
        <h1 className="text-lg font-semibold text-zinc-100">广告转化看板</h1>
        <div className="mt-6 rounded-xl border border-ink-700 bg-ink-900 p-6 text-sm text-zinc-400">
          <p>还没有数据。先生成快照：</p>
          <pre className="mt-3 rounded-lg bg-ink-950 p-3 text-xs text-zinc-300">npm run pull</pre>
          <div className="mt-4">
            <Button variant="primary" onClick={refresh} disabled={refreshing}>
              {refreshing ? "刷新中…（约 1–3 分钟）" : "刷新数据"}
            </Button>
          </div>
          {err && <p className="mt-3 text-xs text-rose-400">{err}</p>}
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-6xl p-5">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">广告转化看板</h1>
          <p className="mt-0.5 text-xs text-zinc-500">
            {allDates[0]} ~ {allDates[allDates.length - 1]}
            {generatedAt && ` · 更新于 ${new Date(generatedAt).toLocaleString("zh-CN")}`}
            <span className="ml-1 text-zinc-600">· 后台自动更新</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          {hasUpdate && (
            <button
              onClick={() => window.location.reload()}
              className="rounded-lg border border-emerald-800 bg-emerald-950/40 px-3 py-1.5 text-xs text-emerald-300 hover:bg-emerald-900/40"
            >
              ● 有新数据，点击加载
            </button>
          )}
          <Button variant="primary" onClick={refresh} disabled={refreshing}>
            {refreshing ? "刷新中…" : "立即刷新"}
          </Button>
        </div>
      </header>

      {/* 全局筛选栏：App + 广告账户 + 广告系列 + 日期 + 来源 */}
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-ink-700 bg-ink-900/60 p-2">
        <Select label="应用" value={appId} options={APPS} onChange={setAppId} />
        <MultiSelect label="广告账户" options={accountOpts} selected={accounts} onChange={setAccounts} />
        <MultiSelect label="广告系列" options={campaignOpts} selected={campaigns} onChange={setCampaigns} />
        <DateRangePicker min={allDates[0]} max={allDates[allDates.length - 1]} from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} />
        {(accounts.length || campaigns.length) > 0 && (
          <button className="text-xs text-zinc-500 hover:text-zinc-300" onClick={() => { setAccounts([]); setCampaigns([]); }}>清除广告筛选</button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-zinc-500">来源</span>
          <Segmented<SourceSel> value={source} onChange={setSource} options={SOURCE_OPTIONS} />
        </div>
      </div>

      {!hasCampaign && (
        <div className="mb-4 rounded-lg border border-amber-900/60 bg-amber-950/20 px-3 py-2 text-xs text-amber-300/90">
          当前快照没有广告系列明细。运行 <code className="text-amber-200">npm run pull</code>（或点「刷新数据」）拉取后即可按账户/系列筛选。
        </div>
      )}

      {err && <p className="mb-3 rounded-lg border border-rose-900 bg-rose-950/40 px-3 py-2 text-xs text-rose-300">刷新失败：{err}</p>}
      {notice && <p className="mb-3 rounded-lg border border-sky-900 bg-sky-950/40 px-3 py-2 text-xs text-sky-300">{notice}</p>}

      <div className="mb-4">
        <Segmented<Tab>
          value={tab}
          onChange={setTab}
          options={[
            { value: "overview", label: "广告概览" },
            { value: "funnel", label: "转化漏斗" },
            { value: "daily", label: "日报" },
          ]}
        />
      </div>

      {tab === "overview" && (snapshot ? <Overview snapshot={snapshot} funnel={funnel} sel={sel} source={source} /> : <Empty what="广告花费(snapshot.json)" />)}
      {tab === "funnel" && (funnel && snapshot ? <FunnelView funnel={funnel} snapshot={snapshot} sel={sel} source={source} /> : <Empty what="转化漏斗(funnel.json)" />)}
      {tab === "daily" && (snapshot && funnel ? <DailyReport snapshot={snapshot} funnel={funnel} sel={sel} source={source} dates={allDates} /> : <Empty what="快照或漏斗" />)}
    </main>
  );
}

function Empty({ what }: { what: string }) {
  return (
    <div className="rounded-xl border border-ink-700 bg-ink-900 p-6 text-sm text-zinc-500">
      缺少 {what} 数据，点右上角「刷新数据」或运行 <code className="text-zinc-300">npm run pull</code>。
    </div>
  );
}
