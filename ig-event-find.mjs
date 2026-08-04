// 找 instagram_reward_type 挂在哪个事件上：直接对候选事件做过滤查询，
// 「返回空」和「属性不存在」在 BytePlus 里都表现为空 → 用「同一事件不加过滤有数」做对照，
// 只要不加过滤有数、加过滤为空，就能确定该事件上这个属性取不到 bind_task。
import { fetchEventDaily } from "./lib/byteplus.mjs";
const TZ = "America/Chicago";

const CANDIDATES = [
  "pwa_task_complete",
  "pwa_earning_ins_task_page_two_click",
  "pwa_task_reward_get",
  "pwa_ins_bind_success",
  "pwa_ins_task_complete",
  "pwa_instagram_bind",
  "pwa_earning_ins_task_complete",
  "pwa_ins_reward",
];

const sum = (r) => r.reduce((a, x) => a + x.count, 0);
const tail = (r) => r.slice(-4).map((x) => `${x.date.slice(5)}=${x.count}`).join(" ");

for (const ev of CANDIDATES) {
  let base;
  try {
    base = await fetchEventDaily({ eventName: ev, lastDays: 10, indicator: "event_users", timezone: TZ });
  } catch (e) { console.log(`${ev.padEnd(38)} 事件不存在/查询失败`); continue; }
  const n = sum(base);
  if (n === 0) { console.log(`${ev.padEnd(38)} 存在但 10 天内 0 事件`); continue; }
  let withProp = 0;
  try {
    withProp = sum(await fetchEventDaily({
      eventName: ev, lastDays: 10, indicator: "event_users", timezone: TZ,
      filters: [{ property: "instagram_reward_type", values: ["bind_task"] }],
    }));
  } catch { withProp = -1; }
  console.log(`${ev.padEnd(38)} 总量 ${String(n).padStart(6)}  带 instagram_reward_type=bind_task: ${withProp < 0 ? "查询报错" : withProp}`);
  console.log(`${" ".repeat(38)} 近4天 ${tail(base)}`);
}
