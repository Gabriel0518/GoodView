import type { CampaignRow, Snapshot } from "./data";

export type Sel = { accounts: string[]; campaigns: string[]; from: string; to: string };
export type DaySpend = { date: string; cost: number; impression: number; click: number };

export function accountOptions(rows: CampaignRow[]) {
  const m = new Map<string, string>();
  rows.forEach((r) => m.set(r.account_id, r.account_name));
  return [...m].map(([value, label]) => ({ value, label, hint: value.slice(-6) }));
}

export function campaignOptions(rows: CampaignRow[], accounts: string[]) {
  const accSet = new Set(accounts);
  const m = new Map<string, { label: string; acc: string }>();
  rows.forEach((r) => {
    if (accSet.size && !accSet.has(r.account_id)) return;
    m.set(r.campaign_id, { label: r.campaign_name, acc: r.account_name });
  });
  return [...m].map(([value, v]) => ({ value, label: v.label, hint: v.acc }));
}

export function filterCampaign(rows: CampaignRow[], sel: Sel) {
  const a = new Set(sel.accounts);
  const c = new Set(sel.campaigns);
  return rows.filter((r) => r.date >= sel.from && r.date <= sel.to && (!a.size || a.has(r.account_id)) && (!c.size || c.has(r.campaign_id)));
}

// 每日花费：优先用 campaign 明细（可按账户/系列筛选），无则回退 byDate（全部客户端）
export function dailySpend(snapshot: Snapshot, sel: Sel): Record<string, DaySpend> {
  const out: Record<string, DaySpend> = {};
  const cr = snapshot.campaignRows;
  if (cr?.length) {
    for (const r of filterCampaign(cr, sel)) {
      const o = (out[r.date] ||= { date: r.date, cost: 0, impression: 0, click: 0 });
      o.cost += r.cost; o.impression += r.impression; o.click += r.click;
    }
  } else {
    for (const r of snapshot.byDate) {
      if (r.date >= sel.from && r.date <= sel.to) out[r.date] = { date: r.date, cost: r.cost, impression: r.impression, click: r.click };
    }
  }
  return out;
}

export const spendTotals = (byDate: Record<string, DaySpend>) =>
  Object.values(byDate).reduce(
    (a, r) => ({ cost: a.cost + r.cost, impression: a.impression + r.impression, click: a.click + r.click }),
    { cost: 0, impression: 0, click: 0 },
  );

// 渠道级归因：BytePlus source ↔ XMP 渠道(module)。null=无直接渠道映射(成本走 costBasis：选系列则用系列花费，否则 None)
export const SOURCE_TO_CHANNEL: Record<string, string | null> = {
  fb: "facebook", tt: "tiktok", bff: null,
  AIguild: null, AIguild_active: null, AIguild_passive: null, unknown: null,
};
export const CHANNEL_LABEL: Record<string, string> = { facebook: "Facebook", tiktok: "TikTok", google: "Google" };

// BytePlus 事件来源（用户属性 source）。AIguild_active=主动(用户直发)/AIguild_passive=被动(留咨)/AIguild=未细分；unknown=无source值(=全量−已知源)
export const SOURCES = ["fb", "tt", "bff", "AIguild", "AIguild_active", "AIguild_passive", "unknown"] as const;
export type SourceSel = "all" | "fb" | "tt" | "bff" | "AIguild" | "AIguild_active" | "AIguild_passive" | "unknown";
export const SOURCE_OPTIONS: { value: SourceSel; label: string }[] = [
  { value: "all", label: "合计" },
  { value: "fb", label: "fb" },
  { value: "tt", label: "tt" },
  { value: "bff", label: "bff" },
  { value: "AIguild", label: "公会" },
  { value: "AIguild_active", label: "主动" },
  { value: "AIguild_passive", label: "被动" },
  { value: "unknown", label: "不明" },
];
const SRC_NAME: Record<string, string> = {
  all: "合计", fb: "fb", tt: "tt", bff: "bff",
  AIguild: "AIguild(未细分)", AIguild_active: "AI主动·直发", AIguild_passive: "AI被动·留咨", unknown: "不明来源",
};
export const srcName = (s: SourceSel) => SRC_NAME[s] ?? s;

// 各 XMP 渠道花费（仅按日期，不受账户/系列筛选影响——渠道级=整个渠道）
export function spendByChannel(snapshot: Snapshot, from: string, to: string): Record<string, number> {
  const out: Record<string, number> = {};
  const cr = snapshot.campaignRows;
  const rows = cr?.length ? cr.filter((r) => r.date >= from && r.date <= to) : snapshot.byChannelDate.filter((r) => r.date >= from && r.date <= to);
  for (const r of rows) out[r.channel] = (out[r.channel] || 0) + r.cost;
  return out;
}

// 各 XMP 渠道的花费/曝光/点击（渠道级，仅按日期）
export function channelStats(snapshot: Snapshot, from: string, to: string): Record<string, { cost: number; impression: number; click: number }> {
  const out: Record<string, { cost: number; impression: number; click: number }> = {};
  const cr = snapshot.campaignRows;
  const rows = cr?.length ? cr.filter((r) => r.date >= from && r.date <= to) : snapshot.byChannelDate.filter((r) => r.date >= from && r.date <= to);
  for (const r of rows) {
    const o = (out[r.channel] ||= { cost: 0, impression: 0, click: 0 });
    o.cost += r.cost; o.impression += r.impression; o.click += r.click;
  }
  return out;
}

// 统一成本基准：
//  - 选了账户/系列 → 用选中广告的花费（不受来源影响，AIguild 也读到花费）
//  - 未选 → 回落到渠道口径(fb→Facebook, tt→TikTok；bff/AIguild 无对应渠道=自然流量)
export function costBasis(snapshot: Snapshot, sel: Sel, source: SourceSel): { cost: number; impression: number; click: number; noPaid: boolean; byCampaign: boolean } {
  if (sel.accounts.length || sel.campaigns.length) {
    const t = spendTotals(dailySpend(snapshot, sel));
    return { cost: t.cost, impression: t.impression, click: t.click, noPaid: false, byCampaign: true };
  }
  const chStats = channelStats(snapshot, sel.from, sel.to);
  const channel = source === "all" ? null : SOURCE_TO_CHANNEL[source];
  const noPaid = source !== "all" && !channel;
  const stat = source === "all"
    ? Object.values(chStats).reduce((a, b) => ({ cost: a.cost + b.cost, impression: a.impression + b.impression, click: a.click + b.click }), { cost: 0, impression: 0, click: 0 })
    : channel ? chStats[channel] || { cost: 0, impression: 0, click: 0 } : { cost: 0, impression: 0, click: 0 };
  return { ...stat, noPaid, byCampaign: false };
}

// 渠道明细（campaign 明细优先，否则 byChannelDate）
export function channelBreakdown(snapshot: Snapshot, sel: Sel) {
  const m: Record<string, { channel: string; cost: number; impression: number; click: number }> = {};
  const cr = snapshot.campaignRows;
  const src = cr?.length
    ? filterCampaign(cr, sel)
    : snapshot.byChannelDate.filter((r) => r.date >= sel.from && r.date <= sel.to);
  for (const r of src) {
    const o = (m[r.channel] ||= { channel: r.channel, cost: 0, impression: 0, click: 0 });
    o.cost += r.cost; o.impression += r.impression; o.click += r.click;
  }
  return Object.values(m).sort((a, b) => b.cost - a.cost);
}
