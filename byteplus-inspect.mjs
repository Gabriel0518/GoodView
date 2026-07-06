// 通用探查：把某事件按某属性分组，看实际取值。调试漏斗某阶段用。
// 用法：node byteplus-inspect.mjs <event_name> [property=source] [type=event_param|profile]
import { fetchEventDailyGrouped } from "./lib/byteplus.mjs";

const [, , event, property = "source", type = "event_param"] = process.argv;
const DAYS = 30;

if (!event) {
  console.error("用法: node byteplus-inspect.mjs <event_name> [property=source] [type=event_param|profile]");
  process.exit(1);
}

const res = await fetchEventDailyGrouped({
  eventName: event, lastDays: DAYS,
  groups: [{ property_name: property, property_type: type, location: type === "profile" ? "content" : "event" }],
});

console.log(`「${event}」按 ${property}(${type}) 分组，最近 ${DAYS} 天：\n`);
const rows = [...res.series].sort((a, b) => b.sum - a.sum);
if (!rows.length) console.log("  (无数据)");
for (const s of rows) console.log(`  ${JSON.stringify(s.group).padEnd(28)} ${s.sum}`);
