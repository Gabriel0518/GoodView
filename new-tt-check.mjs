// 核对新增的 3 个 TikTok PWA 账户：ID 是否存在、渠道、系列名（确认是 PWA 不是别产品）
import { fetchReport } from "./lib/xmp.mjs";

const NEW = {
  "7639625690962640914": "zmf",
  "7639625025477623815": "wcx",
  "7639625716434485256": "ymt",
};
const ymd = (d) => d.toISOString().slice(0, 10);
const to = new Date();
const from = new Date();
from.setDate(from.getDate() - 3);

const rows = await fetchReport({
  startDate: ymd(from), endDate: ymd(to),
  dimension: ["date", "account_name", "campaign_id", "campaign_name"],
  metrics: ["cost", "impression", "click"],
});

console.log(`XMP 报表返回 ${rows.length} 行（${ymd(from)} ~ ${ymd(to)}）\n`);
for (const [id, owner] of Object.entries(NEW)) {
  const mine = rows.filter((r) => String(r.account_id) === id);
  const name = mine.find((r) => r.account_name)?.account_name || "(报表里查无此账户)";
  const mods = [...new Set(mine.map((r) => r.module).filter(Boolean))];
  const cost = mine.reduce((s, r) => s + (Number(r.cost) || 0), 0);
  const imp = mine.reduce((s, r) => s + (Number(r.impression) || 0), 0);
  const camps = [...new Set(mine.map((r) => r.campaign_name || r.campaign_id).filter(Boolean))];
  console.log(`${id}  优化师=${owner}`);
  console.log(`  账户名: ${name}`);
  console.log(`  渠道: ${mods.join(",") || "-"} · 花费 $${cost.toFixed(2)} · 曝光 ${imp} · 行数 ${mine.length}`);
  console.log(`  系列: ${camps.slice(0, 5).join(" / ") || "(无系列，昨天新建、尚未投放)"}\n`);
}
