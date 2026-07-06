// 探测「事件属性过滤」的正确写法：给 pwa_task_complete 加 task_id=102，
// 合计比基线(不过滤)变小 => 过滤生效。自我验证，不用猜对错。
// 用法：node byteplus-filter-probe.mjs
import { fetchEventDailyGrouped } from "./lib/byteplus.mjs";

const DAYS = 30;
const EVENT = "pwa_task_complete";
const SOURCES = ["AIguild", "fb", "tt", "bff"];
const sumOf = (res) => SOURCES.reduce((a, s) => a + (res.series.find((x) => x.group === s)?.sum || 0), 0);

// 各种候选过滤对象（都表示 task_id = 102）
const CANDS = [
  { label: "property_operation + values(str)", f: { property_type: "event_param", property_name: "task_id", property_operation: "=", values: ["102"] } },
  { label: "operator + values", f: { property_type: "event_param", property_name: "task_id", operator: "=", values: ["102"] } },
  { label: "op + values", f: { property_type: "event_param", property_name: "task_id", op: "=", values: ["102"] } },
  { label: "property_operation: in", f: { property_type: "event_param", property_name: "task_id", property_operation: "in", values: ["102"] } },
  { label: "values as number", f: { property_type: "event_param", property_name: "task_id", property_operation: "=", values: [102] } },
  { label: "filter_type", f: { property_type: "event_param", property_name: "task_id", filter_type: "=", values: ["102"] } },
  { label: "property_type = event", f: { property_type: "event", property_name: "task_id", property_operation: "=", values: ["102"] } },
  { label: "value(singular)", f: { property_type: "event_param", property_name: "task_id", property_operation: "=", value: ["102"] } },
  { label: "no property_type", f: { property_name: "task_id", property_operation: "=", values: ["102"] } },
  { label: "operation ==", f: { property_type: "event_param", property_name: "task_id", property_operation: "==", values: ["102"] } },
  { label: "dim/op/value", f: { dim: "task_id", op: "=", value: ["102"] } },
];

async function main() {
  const base = await fetchEventDailyGrouped({ eventName: EVENT, lastDays: DAYS, groupBy: "source", propertyType: "profile", groupLocation: "content" });
  const baseTotal = sumOf(base);
  console.log(`基线（不过滤）合计 = ${baseTotal}`);
  console.log(`目标：task_id=102 生效后合计应 < ${baseTotal}\n`);

  let winner = null;
  for (const c of CANDS) {
    try {
      const res = await fetchEventDailyGrouped({ eventName: EVENT, lastDays: DAYS, groupBy: "source", propertyType: "profile", groupLocation: "content", rawFilters: [c.f] });
      const t = sumOf(res);
      const applied = t !== baseTotal && t > 0;
      console.log(`${applied ? "✅" : "· "} ${c.label.padEnd(32)} 合计=${String(t).padEnd(8)} ${applied ? "← 过滤生效!" : "(无变化=被忽略)"}`);
      if (applied && !winner) winner = c;
    } catch (e) {
      console.log(`✗  ${c.label.padEnd(32)} ${e.message.replace(/\s+/g, " ").slice(0, 40)}`);
    }
  }

  console.log("");
  if (winner) console.log(`✅ 正确过滤写法：${JSON.stringify(winner.f)}`);
  else console.log("⚠️ 没有一种写法让数字变化。要么 task_id 属性名不对，要么过滤结构差异更大——那就得抓 UI 的请求体了。");
}

main().catch((e) => {
  console.error("失败：", e.message);
  if (e.cause) console.error("底层原因：", e.cause);
  process.exit(1);
});
