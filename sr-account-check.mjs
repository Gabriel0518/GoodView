// 核对上架包(SmartReply)账户：ID 是否存在、近期系列名与花费、渠道
import { fetchReport } from "./lib/xmp.mjs";

const IDS = ["6245583421", "7665547836257058834", "27589868840681799", "1013644987935186"];
const ymd = (d) => d.toISOString().slice(0, 10);
const to = new Date();
const from = new Date();
from.setDate(from.getDate() - 14);

const rows = await fetchReport({
  startDate: ymd(from), endDate: ymd(to),
  dimension: ["date", "account_name", "campaign_id", "campaign_name"],
  metrics: ["cost", "impression", "click"],
});

for (const id of IDS) {
  const mine = rows.filter((r) => String(r.account_id) === id);
  const cost = mine.reduce((s, r) => s + (Number(r.cost) || 0), 0);
  const name = mine.find((r) => r.account_name)?.account_name || "(报表里无此账户)";
  const mods = [...new Set(mine.map((r) => r.module).filter(Boolean))];
  const camps = [...new Set(mine.filter((r) => Number(r.cost) > 0).map((r) => r.campaign_name || r.campaign_id))];
  const days = [...new Set(mine.filter((r) => Number(r.cost) > 0).map((r) => r.date))].sort();
  console.log(`\n${id}  ${name}`);
  console.log(`  渠道(module)=${mods.join(",") || "-"} · 近14天花费=$${cost.toFixed(2)} · 有花费天数=${days.length}${days.length ? ` (${days[0]}~${days[days.length - 1]})` : ""}`);
  console.log(`  系列: ${camps.slice(0, 6).join(" / ") || "(无花费系列)"}`);
}
