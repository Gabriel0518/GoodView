export type SnapDate = {
  date: string;
  cost: number;
  impression: number;
  click: number;
  cpm: number;
  ctr: number;
  cpc: number;
  ig_auth: number;
  cost_per_ig_auth: number;
};
export type SnapChannel = {
  channel: string;
  cost: number;
  impression: number;
  click: number;
  cpm: number;
  ctr: number;
  cpc: number;
};
export type SnapChannelDate = { date: string; channel: string; cost: number; impression: number; click: number };
export type CampaignRow = {
  date: string;
  account_id: string;
  account_name: string;
  channel: string;
  campaign_id: string;
  campaign_name: string;
  adset_id: string;
  adset_name: string;
  cost: number;
  impression: number;
  click: number;
};
export type Snapshot = {
  meta: { start_date: string; end_date: string; days: number; currency: string; generated_at: string; ig_auth_event: string };
  byDate: SnapDate[];
  byChannel: SnapChannel[];
  byChannelDate: SnapChannelDate[];
  igAuthByDate: { date: string; count: number }[];
  campaignRows?: CampaignRow[];
};

export type StageSource = { data: number[]; sum: number };
export type Stage = {
  key: string;
  label: string;
  name: string;
  filters: { property: string; values: string[] }[] | null;
  status: string;
  bySource: Record<string, StageSource>;
  total: number;
};
export type Funnel = {
  meta: { days: number; sources: string[]; generated_at: string; app_id: number };
  dates: string[];
  stages: Stage[];
};

// 数据来源：Postgres（见 db-queries.ts）。类型与前端组件/compute.ts 完全不变。
// page.tsx 用的加载器对 DB 错误容错（返回 null → 页面显示“无数据/去拉取”），不崩页。
import { getSnapshot, getFunnel } from "./db-queries";

export async function loadSnapshot(): Promise<Snapshot | null> {
  try {
    return await getSnapshot();
  } catch (e) {
    console.error("loadSnapshot 失败：", e);
    return null;
  }
}
export async function loadFunnel(): Promise<Funnel | null> {
  try {
    return await getFunnel();
  } catch (e) {
    console.error("loadFunnel 失败：", e);
    return null;
  }
}
