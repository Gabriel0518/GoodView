import { loadSnapshot, loadFunnel } from "../lib/data";
import Dashboard from "../components/Dashboard";

// v1 旧版看板（概览/漏斗/日报）—— P2 灰度期保留只读，稳定后随 compute.ts 一并退役。
export const dynamic = "force-dynamic";

export default async function LegacyPage() {
  const [snapshot, funnel] = await Promise.all([loadSnapshot(), loadFunnel()]);
  return <Dashboard snapshot={snapshot} funnel={funnel} />;
}
