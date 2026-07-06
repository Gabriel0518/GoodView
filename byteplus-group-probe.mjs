// 验证「按 task_id 分组」能否区分不同任务，以及能否同时按 source 拆。
// 用法：node byteplus-group-probe.mjs
import { fetchEventDailyGrouped } from "./lib/byteplus.mjs";

const DAYS = 30;
const EVENT = "pwa_task_complete";

async function main() {
  // 测试 1：只按 task_id(event_param) 分组 —— 应看到各 task_id 的不同数字
  console.log("=== 测试1：pwa_task_complete 按 task_id 分组 ===");
  try {
    const r1 = await fetchEventDailyGrouped({
      eventName: EVENT, lastDays: DAYS,
      groups: [{ property_name: "task_id", property_type: "event_param", location: "event" }],
    });
    [...r1.series].sort((a, b) => b.sum - a.sum).slice(0, 20)
      .forEach((s) => console.log(`   task_id=${JSON.stringify(s.group)}  ${s.sum}`));
  } catch (e) {
    console.log("   ✗", e.message);
  }

  // 测试 2：同时按 source(profile) + task_id(event_param) 二维分组
  console.log("\n=== 测试2：同时按 source + task_id 二维分组（看 group_by_key 结构）===");
  try {
    const r2 = await fetchEventDailyGrouped({
      eventName: EVENT, lastDays: DAYS,
      groups: [
        { property_name: "source", property_type: "profile", location: "content" },
        { property_name: "task_id", property_type: "event_param", location: "event" },
      ],
    });
    console.log(`   返回 ${r2.series.length} 组，前 25 组：`);
    [...r2.series].sort((a, b) => b.sum - a.sum).slice(0, 25)
      .forEach((s) => console.log(`   ${JSON.stringify(s.group)}  ${s.sum}`));
  } catch (e) {
    console.log("   ✗", e.message);
  }
}

main().catch((e) => {
  console.error("失败：", e.message);
  if (e.cause) console.error("底层原因：", e.cause);
  process.exit(1);
});
