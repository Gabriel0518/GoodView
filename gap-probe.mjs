// 对口径：用户给的 7/28 参考数 vs 我们抓的数，穷举 指标类型(UV/PV) × 时区 定位差异来源
//   用户参考：德州 注册 59 / IG绑定 14；全量 注册 322 / IG绑定 58
import { fetchEventDaily, REGION_EXPRS } from "./lib/byteplus.mjs";

const TARGET = "2026-07-28";
const WANT = { all: { register: 322, ig_bind: 58 }, TX: { register: 59, ig_bind: 14 } };
const METRICS = {
  register: { event: "pwa_conv_cash_ready_pop_show", filters: null },
  ig_bind: { event: "pwa_task_complete", filters: [{ property: "task_id", values: [110] }] },
};
const TZS = ["Asia/Shanghai", "America/Chicago", "US/Eastern", "UTC"];
const INDS = { UV: "event_users", PV: "events" };

// 覆盖到 7/28 的窗口：按各时区取"最近 N 天"，再从 date_index 里挑 7/28
const DAYS = 5;

const out = [];
for (const tz of TZS) {
  for (const [mk, m] of Object.entries(METRICS)) {
    for (const [il, ind] of Object.entries(INDS)) {
      for (const region of ["all", "TX"]) {
        const daily = await fetchEventDaily({
          eventName: m.event, lastDays: DAYS, indicator: ind, filters: m.filters,
          profileExpressions: REGION_EXPRS[region], timezone: tz,
        });
        const hit = daily.find((d) => d.date === TARGET);
        out.push({ tz, metric: mk, ind: il, region, value: hit ? hit.count : null });
      }
    }
  }
}

const mark = (r) => (r.value === WANT[r.region][r.metric] ? "  ✅ 完全命中" : "");
console.log(`7/28 交叉矩阵（用户参考：全量 注册 ${WANT.all.register} / IG ${WANT.all.ig_bind}；德州 注册 ${WANT.TX.register} / IG ${WANT.TX.ig_bind}）\n`);
console.log("时区              指标      类型  地区    我们的值   参考值   差");
for (const r of out) {
  const want = WANT[r.region][r.metric];
  const d = r.value == null ? "-" : r.value - want;
  console.log(
    `${r.tz.padEnd(16)} ${r.metric.padEnd(9)} ${r.ind.padEnd(5)} ${r.region.padEnd(6)} ${String(r.value ?? "无").padStart(8)} ${String(want).padStart(8)} ${String(d).padStart(6)}${mark(r)}`,
  );
}
