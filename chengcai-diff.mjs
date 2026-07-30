// 核对：funnel 的 chengcai(成材) 口径 vs 官方关键指标看板口径的差额
//   funnel:  withdraw_amount=25 OR will_cashout_stage=CashoutStageFive，UV
//   官方关键指标: withdraw_amount=25 单条，PV
import { fetchEventDaily } from "./lib/byteplus.mjs";

const EV = "pwa_withdraw_audit_apply";
const DAYS = 30;
const sum = (a) => a.reduce((s, x) => s + x.count, 0);

const both25or5 = await fetchEventDaily({ eventName: EV, lastDays: DAYS, indicator: "event_users",
  filters: [{ property: "withdraw_amount", values: [25] }, { property: "will_cashout_stage", values: ["CashoutStageFive"] }] });
const only25uv = await fetchEventDaily({ eventName: EV, lastDays: DAYS, indicator: "event_users",
  filters: [{ property: "withdraw_amount", values: [25] }] });
const only25pv = await fetchEventDaily({ eventName: EV, lastDays: DAYS, indicator: "events",
  filters: [{ property: "withdraw_amount", values: [25] }] });
const onlyStage = await fetchEventDaily({ eventName: EV, lastDays: DAYS, indicator: "event_users",
  filters: [{ property: "will_cashout_stage", values: ["CashoutStageFive"] }] });

console.log(`成材口径对比（最近 ${DAYS} 天，全量，已排测试用户）`);
console.log(`  funnel 现口径  25 OR CashoutStageFive · UV = ${sum(both25or5)}`);
console.log(`  官方关键指标   25 单条 · PV             = ${sum(only25pv)}`);
console.log(`  参考           25 单条 · UV             = ${sum(only25uv)}`);
console.log(`  参考           仅 CashoutStageFive · UV = ${sum(onlyStage)}`);
