// 德州 昨天/今天（北京时间）：安装 / 注册 / IG绑定
import { fetchEventDaily, REGION_EXPRS } from "./lib/byteplus.mjs";
import { query as dms } from "./lib/dms.mjs";

const TZ = "Asia/Shanghai";
const now = new Date();
const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(now);
const hh = Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour12: false, hour: "2-digit" }).format(now));
console.log(`北京时间现在 ${today} ${String(hh).padStart(2, "0")}:xx —— 今天已走 ${hh} 小时（约 ${Math.round(hh / 24 * 100)}%），昨天是完整日\n`);

const M = [
  ["安装成功", "web_install_success", null],
  ["注册(0.5刀弹窗)", "pwa_conv_cash_ready_pop_show", null],
  ["IG绑定", "pwa_task_complete", [{ property: "task_id", values: [110] }]],
];

const out = {};
for (const [label, ev, filters] of M) {
  const all = await fetchEventDaily({ eventName: ev, lastDays: 2, indicator: "event_users", filters, timezone: TZ });
  const tx = await fetchEventDaily({ eventName: ev, lastDays: 2, indicator: "event_users", filters,
    profileExpressions: REGION_EXPRS.TX, timezone: TZ });
  out[label] = { all, tx };
}

const dates = out["安装成功"].all.map((r) => r.date);
for (let i = 0; i < dates.length; i++) {
  const d = dates[i];
  console.log(`【${d}】${d === today ? `  ← 今天（进行中，${hh}/24 小时）` : "  ← 昨天（完整日）"}`);
  console.log("  指标              德州    全量    德州占比");
  for (const [label] of M) {
    const a = out[label].all[i]?.count ?? 0, t = out[label].tx[i]?.count ?? 0;
    console.log(`  ${label.padEnd(16)}${String(t).padStart(6)}${String(a).padStart(8)}${(a > 0 ? (t / a * 100).toFixed(1) + "%" : "—").padStart(10)}`);
  }
  console.log("");
}

// 业务库全量注册对照（BytePlus 注册事件 08-02 起失效）
const reg = await dms(`
  SELECT ((created_at AT TIME ZONE 'UTC') AT TIME ZONE '${TZ}')::date::text d, count(*) n
    FROM userinfo WHERE app_name='3'
     AND ((created_at AT TIME ZONE 'UTC') AT TIME ZONE '${TZ}')::date >= '${dates[0]}'
     AND ((email<>'' AND email IS NOT NULL) OR (phone_number<>'' AND phone_number IS NOT NULL))
   GROUP BY 1 ORDER BY 1`);
console.log("⚠️ 注册对照（业务库全量，无法切德州）：");
reg.forEach((r) => console.log(`   ${r.d}  ${r.n}`));
console.log("   BytePlus 的注册事件 08-02 起失效（业务库在涨、BytePlus 腰斩），上面德州注册数会偏低。");
