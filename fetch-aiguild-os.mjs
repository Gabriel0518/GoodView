// AI公会 分端(android/ios) 转化抓取。拉注册/首提/IG授权/成材 4 阶段，按 source×os_name 分组，
// 只保留 AI公会来源(AIguild/active/passive)，按 os 聚合 → 写 aiguild_os_daily。
// 注册归因不到广告组，但能到 os(用户设备属性 os_name)。数据量小(个位数/天)，看周期汇总更靠谱。
// 用法：node fetch-aiguild-os.mjs [天数]（默认 35，含当天）
import { withTx, bulkInsert, end } from "./lib/db.mjs";
import { fetchEventDailyGrouped, buildEventFilter } from "./lib/byteplus.mjs";
import { FUNNEL } from "./funnel-events.mjs";

const AI_SOURCES = new Set(["AIguild", "AIguild_active", "AIguild_passive"]);
const STAGE_KEYS = ["cash_ready_show", "withdraw_first", "task_ins_bind", "chengcai"];
// os_name → 归一：android / ios / other
const normOs = (o) => (o === "android" ? "android" : o === "ios" ? "ios" : "other");

async function main() {
  const days = Number(process.argv[2]) || 35;
  const stages = STAGE_KEYS.map((k) => FUNNEL.find((s) => s.key === k)).filter(Boolean);
  console.log(`[aiguild-os] 拉 AI公会分端 ${stages.length} 阶段 × os，近 ${days} 天（含当天）`);

  // date|stage|os → count
  const acc = {};
  const allDates = new Set();
  for (const st of stages) {
    const res = await fetchEventDailyGrouped({
      eventName: st.name, lastDays: days,
      groups: [
        { property_name: "source", property_type: "profile", location: "content" },
        { property_name: "os_name", property_type: "profile", location: "content" },
      ],
      rawFilters: st.filters ? buildEventFilter(st.filters) : null,
    });
    const dates = res.dates; // ["YYYY-MM-DD", ...]
    dates.forEach((d) => allDates.add(d));
    for (const s of res.series) {
      const [src, os] = String(s.group).split(",");
      if (!AI_SOURCES.has(src)) continue;               // 只留 AI公会来源
      const o = normOs(os);
      (s.data || []).forEach((v, i) => {
        const d = dates[i]; if (!d) return;
        const key = `${d}|${st.key}|${o}`;
        acc[key] = (acc[key] || 0) + (Number(v) || 0);
      });
    }
    await new Promise((r) => setTimeout(r, 400));        // 轻微限速
  }

  const rows = Object.entries(acc)
    .filter(([, v]) => v > 0)
    .map(([k, count]) => { const [date, stage_key, os] = k.split("|"); return { date, stage_key, os, count }; });
  const dateList = [...allDates].sort();
  const from = dateList[0], to = dateList[dateList.length - 1];

  await withTx(async (c) => {
    await c.query("DELETE FROM aiguild_os_daily WHERE date >= $1 AND date <= $2", [from, to]);
    await bulkInsert(c, "aiguild_os_daily", [
      { name: "date", type: "date" }, { name: "stage_key", type: "text" },
      { name: "os", type: "text" }, { name: "count", type: "bigint" },
    ], rows);
  });
  console.log(`[aiguild-os] ✅ 写入 aiguild_os_daily：${rows.length} 行（${from}~${to}）`);
}

main()
  .catch((e) => { console.error("[aiguild-os] 失败：", e.message); process.exitCode = 1; })
  .finally(() => end().catch(() => {}));
