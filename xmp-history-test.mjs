// 探测 XMP 历史数据深度：拉几个不同时间窗口，看老日期还有没有数据。
// 判断 XMP 是"只有最近90天" 还是"每次限90天但有更久历史"。
// 用法：node xmp-history-test.mjs
import { fetchReport } from "./lib/xmp.mjs";

const ymd = (d) => d.toISOString().slice(0, 10);
const addDays = (base, n) => { const d = new Date(base); d.setUTCDate(d.getUTCDate() + n); return d; };

async function probe(label, startDate, endDate) {
  try {
    const rows = await fetchReport({ startDate, endDate, dimension: ["date"], metrics: ["cost", "impression"] });
    const cost = rows.reduce((a, r) => a + (Number(r.cost) || 0), 0);
    const dates = [...new Set(rows.map((r) => r.date))].sort();
    console.log(`${label}  ${startDate}~${endDate}: ${rows.length} 行, 花费 $${cost.toFixed(2)}, 有数据日期: ${dates.join(", ") || "(无)"}`);
  } catch (e) {
    console.log(`${label}  ${startDate}~${endDate}: ✗ ${e.message.replace(/\s+/g, " ").slice(0, 60)}`);
  }
}

async function main() {
  const today = new Date();
  const w = (from, to) => [ymd(addDays(today, from)), ymd(addDays(today, to))];
  console.log(`探测 XMP 历史深度（今日 ${ymd(today)}）—— 每个窗口 3 天\n`);

  await probe("最近(控制)", ...w(-8, -6));
  await probe("~90天前  ", ...w(-95, -93));
  await probe("~120天前 ", ...w(-122, -120));
  await probe("~180天前 ", ...w(-182, -180));
  await probe("~270天前 ", ...w(-272, -270));
  await probe("~365天前 ", "2025-07-07", "2025-07-09");

  console.log("\n判断：");
  console.log("  · 若老窗口(120天前及更早)都有数据 → XMP 有长历史，只是每次请求限 90 天 → 可分段回补一年。");
  console.log("  · 若 90 天前有、更早的返回空/报错 → XMP 只保留最近 90 天 → 更久历史只能靠每天累积。");
}

main().catch((e) => { console.error("失败：", e.message); if (e.cause) console.error(e.cause); process.exit(1); });
