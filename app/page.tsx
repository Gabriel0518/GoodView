import { loadSnapshot, loadFunnel } from "./lib/data";
import Dashboard from "./components/Dashboard";

// 每次请求重新读文件，刷新数据后 reload 即可看到最新
export const dynamic = "force-dynamic";

export default async function Page() {
  const [snapshot, funnel] = await Promise.all([loadSnapshot(), loadFunnel()]);
  return <Dashboard snapshot={snapshot} funnel={funnel} />;
}
