// BytePlus「PWA 德州关键指标转化率看板」的官方关键指标定义（唯一事实源）。
//
// 逐字对齐 BytePlus 报表 7668160292471177733（看板「PWA德州实验看板」7668155095304897077）的
// dsl_content.queries —— 用 lib/byteplus.mjs 的 getReport() 可随时复核：
//   A 投广页曝光   pwa_conv_lp_show             总人数(UV) = event_users
//   B 安装成功     web_install_success          总人数(UV)
//   C 用户注册     pwa_conv_cash_ready_pop_show 总人数(UV)
//   D 可分发用户   pwa_conv_live_start_click    总人数(UV)
//   E IG绑定用户   pwa_task_complete            总人数(UV) + task_id=110
//   F 成材用户     pwa_withdraw_audit_apply     总次数(PV) = events + withdraw_amount=25
//
// ⚠️ 两处与 funnel_stage_meta（旧「PWA 转化率看板」口径）不同，是刻意的、别顺手"统一"：
//   1) 成材用 **PV(总次数)**，不是 UV：官方关键指标看板就是 events。同一人多次申请 25 刀会重复计
//      （实测 7 天全量 PV=175 / UV=146）。funnel 的 chengcai 阶段仍是 UV（那是「成材人数」，
//      被 AI公会/PWA 单价表当分母用），两者并存、各自正确。
//   2) 成材只按 withdraw_amount=25，**没有** will_cashout_stage=CashoutStageFive 的 OR 条件
//      （funnel 的 chengcai 保留了那条，来自更早的成材报表口径）。
// filters 走 lib/byteplus.mjs buildEventFilter：值必须是数字（[110] 不是 ["110"]），字符串会静默不生效。
export const KEY_METRICS = [
  { key: "lp_show",         label: "投广页曝光",  event: "pwa_conv_lp_show",             indicator: "event_users" },
  { key: "install_success", label: "安装成功",    event: "web_install_success",          indicator: "event_users" },
  { key: "register",        label: "用户注册",    event: "pwa_conv_cash_ready_pop_show", indicator: "event_users" },
  { key: "distributable",   label: "可分发用户",  event: "pwa_conv_live_start_click",    indicator: "event_users" },
  { key: "ig_bind",         label: "IG绑定用户",  event: "pwa_task_complete",            indicator: "event_users",
    filters: [{ property: "task_id", values: [110] }] },
  { key: "chengcai",        label: "成材用户",    event: "pwa_withdraw_audit_apply",     indicator: "events",
    filters: [{ property: "withdraw_amount", values: [25] }] },
];

// 地区细分（表达式在 lib/byteplus.mjs REGION_EXPRS）。
//   TX    = loc_province_id = 4736286（德克萨斯州）
//   nonTX = loc_province_id != 4736286（含省份未知）
//   all   = 不加省份条件
// ⚠️ TX + nonTX 会略大于 all（实测 7 天注册：376 + 1694 = 2070 vs 全量 2061，+0.4%）——
//    loc_province_id 是按事件归因的用户属性，同一人窗口内在德州和外州都有事件时两边各算一次。
//    所以三个地区都独立存一行，前端/仪表盘按需取，不要用减法自己推。
export const REGIONS = [
  { key: "TX",    label: "德州" },
  { key: "nonTX", label: "非德州" },
  { key: "all",   label: "全量" },
];

export const REGION_LABEL = Object.fromEntries(REGIONS.map((r) => [r.key, r.label]));

// 时区：**America/Chicago**（德州本地时间），与 BytePlus「PWA德州实验看板」全部报表一致。
// 2026-07-30 与用户参考数逐个核对确认：7/28 全量注册 322 · IG绑定 58 · 德州注册 59 · IG绑定 14
// —— 芝加哥时区四个数**完全命中**；用项目默认的 Asia/Shanghai 则差 -58/-17/-6/-4（约 -18%），
// 因为芝加哥的一天 = 上海时间当天 13:00 ~ 次日 13:00，按上海切会把当天下午之后的量算到第二天。
// 故这条管道**单独锚芝加哥**，不跟 config.mjs 的 BYTEPLUS.timezone（那个是 Asia/Shanghai，
// 给 funnel/花费对齐用的，2026-07-20 定的，别动）。
//
// ⚠️ 副作用：本表的转化按**芝加哥日**切，XMP 花费按**广告账户时区**（Asia/Shanghai，用户确认）切，
//    两者差 13 小时，所以日级「单价」是近似值。为什么不重切花费到芝加哥日：XMP 没有小时维度
//    （`dimension:["date","hour"]` → `hour not support`），`timezone` 参数被静默忽略（受控对比三天
//    数值完全相同）→ 拿不到真实小时花费；靠 BytePlus 小时流量做权重反推是模型值，且 BytePlus 小时
//    数据只留最近 8 天，历史日只能套平均曲线。用户 2026-07-30 决定：**不重切**，两边各按自己的
//    时区日出数，只要花费总额能对上即可（7/28 实测：我们 $1930.72 vs 用户 $1930.62，差 $0.10）。
//    跨多日汇总时这个错位基本抵消（总额不变，只在相邻两天之间挪），单日单价看趋势别抠绝对值。
export const KEY_METRIC_TIMEZONE = process.env.KEY_METRIC_TIMEZONE || "America/Chicago";
