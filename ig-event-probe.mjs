// 新旧 IG 绑定口径对比：task_id=110  vs  instagram_reward_type=bind_task
import { fetchEventDaily } from "./lib/byteplus.mjs";
const TZ = "America/Chicago";

const run = async (label, filters) => {
  try {
    const r = await fetchEventDaily({
      eventName: "pwa_task_complete", lastDays: 12, indicator: "event_users",
      filters, timezone: TZ,
    });
    const m = {}; r.forEach((x) => { m[x.date] = x.count; });
    return { label, m };
  } catch (e) { console.log(`  ${label} 查询失败：${e.message.slice(0, 120)}`); return { label, m: {} }; }
};

const series = [];
series.push(await run("无过滤(全部任务)", null));
series.push(await run("task_id=110 (旧口径)", [{ property: "task_id", values: [110] }]));
series.push(await run("instagram_reward_type=bind_task (新口径)",
  [{ property: "instagram_reward_type", values: ["bind_task"] }]));
series.push(await run("instagram_reward_type 任意非空",
  [{ property: "instagram_reward_type", values: ["bind_task", "follow_task", "post_task", "hosting_task"] }]));

const dates = [...new Set(series.flatMap((s) => Object.keys(s.m)))].sort();
console.log("日期        " + series.map((s, i) => `口径${i + 1}`.padStart(8)).join(""));
for (const d of dates) console.log(`  ${d}` + series.map((s) => String(s.m[d] ?? "—").padStart(8)).join(""));
console.log("\n口径说明：");
series.forEach((s, i) => console.log(`  口径${i + 1} = ${s.label}`));
