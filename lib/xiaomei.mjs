// 「小美投放转化」看板的口径定义（唯一事实源）。fetch-xiaomei.mjs 与 feishu-tables.mjs 都读这里。
//
// 一行数据 = 日期 × 产品 × 渠道。
//   投放侧(花费/曝光/点击/安装) → XMP（读库里的 campaign_daily + campaign_metric_daily）
//   后端(注册/IG绑定/GoLive/成材) → 以 BytePlus 为主，靠事件属性 pwa_app_name 区分产品
//     （见下方 PWA_APP_NAME_PROP 注释）。两处例外：
//       · PWA 的 注册/IG绑定/成材 + Savvy 的 成材 → 自有业务库(DMS)
//       · Savvy 的 注册/IG绑定/小美注册/小美IG绑定 → BytePlus 的**「当天注册」口径**，
//         见文件末尾 SAVVY_BYTEPLUS（用户 2026-08-19 给的 SQL）
//   SmartReply 单独走 AppsFlyer(af_events)，理由见它自己那行。
//
// 【日界】默认按 America/Chicago 切日（Savvy 那四个指标例外，按 Asia/Shanghai，见 SAVVY_BYTEPLUS） —— 芝加哥的一天 = 北京 13:00 ~ 次日 13:00（夏令时；
// 冬令时是 14:00~14:00，Intl 会自动跟随，不用改代码）。这正是用户要的「用前一日 13:00 到第二日
// 13:00 对齐 XMP 昨日整日」。XMP 侧日期本身按上海日切，两边**不重切、只做 D↔D 标签对齐**
// （为什么不重切花费：XMP 没有小时维度，timezone 参数被静默忽略；完整论证见 lib/key-metrics.mjs）。
import { KEY_METRICS } from "./key-metrics.mjs";

export const XIAOMEI_TIMEZONE = process.env.XIAOMEI_TIMEZONE || "America/Chicago";

// 渠道：XMP 的 module 三值 + 一个「未归因」兜底行（后端指标拆不到渠道时的去处）
export const CHANNELS = ["facebook", "tiktok", "google"];
export const UNATTRIBUTED = "未归因";
export const ALL_CHANNELS = [...CHANNELS, UNATTRIBUTED];

// 产品。backend 决定后端 4 指标默认从哪取；顺序即看板展示顺序。
//   afAppIds：AppsFlyer 的 app_id（af_events.app_id）。
//   dmsAppName + dmsMetrics：从自有业务库(archat)按 userinfo.app_name 取的指标。
//   savvyBpMetrics：走 SAVVY_BYTEPLUS「当天注册」口径的指标（目前只有 Savvy）。
//   dmsMetrics 与 savvyBpMetrics 都会**覆盖**默认来源写进去的同名指标，并统一落「未归因」渠道行
//   （两者都没有渠道维度）；覆盖逻辑在 fetch-xiaomei.mjs 的 overrideUnattributed。
//
// 【历史】2026-08-16 当天曾把 Savvy 改走业务库(app_name=32)、PWA 改走业务库(app_name=3)，
// 因为当时以为 BytePlus 分不出产品。拿到 pwa_app_name 后全部回归 BytePlus。
// 业务库那套口径（建号行、每人一次）仍然有价值：它是「当日真实新增」，而 BytePlus 的日 UV 是
// 「当日看到弹窗的人」含回访老用户，实测前者约为后者的 60~85%。要对账时用 fetch-dms.mjs。
export const PRODUCTS = [
  // 【PWA 的 注册/IG绑定/成材 走业务库】(用户 2026-08-16 拍板)
  //   BytePlus 的「注册」是 0.5刀弹窗**曝光**的日 UV，同一个人跨天再看到会再计一次 → 含回访老用户；
  //   业务库的建号行每人只有一次，是**当日真实新增**。08-15 实测 Savvy 138(BP) vs 114(业务库)、
  //   PWA 137(BP) vs 87(业务库)，差额就是回访。用户要真实新增，故用业务库。
  //   ⚠️ 2026-08-19 起 Savvy 不再需要绕业务库：BytePlus 的 user_register_time 用户属性能直接
  //      切出「当天注册」，见 SAVVY_BYTEPLUS。PWA 想换成同样的口径也是可行的，但用户没要求，没动。
  //   ⚠️ GoLive 业务库没有（pwa_distribution 未接）→ 仍走 BytePlus，用 pwa_app_name 精确过滤。
  //   ⚠️ AI公会 不在业务库里（它是 PWA 的一个流量来源，不是独立 app）→ 只能用 BytePlus，
  //      所以 AI公会 那一行仍是含回访的口径，与另两个产品**不完全可比**，看板说明已标注。
  { key: "PWA",        backend: "byteplus", byteplusScope: "pwa",
    dmsAppName: process.env.PWA_DMS_APP_NAME || "3",
    dmsMetrics: ["register", "ig_bind", "chengcai"] },
  { key: "AI公会",      backend: "byteplus", byteplusScope: "aiguild" },
  // Savvy 的 注册/IG绑定/小美注册/小美IG绑定 走**下面 SAVVY_BYTEPLUS 那套独立口径**
  // （用户 2026-08-19 给了 BytePlus SQL，见该常量的注释）；业务库只保留成材。
  { key: "Savvy",      backend: "byteplus", byteplusScope: "appName",
    savvyBpMetrics: ["register", "ig_bind", "beauty_register", "beauty_ig_bind"],
    channelSplit: true,   // 后端转化能拆到真实渠道（BytePlus 用户属性 media_source）→ 渠道行的单价有意义
    dmsAppName: process.env.SAVVY_DMS_APP_NAME || "32",
    dmsMetrics: ["chengcai"],
    afAppIds: (process.env.SAVVY_AF_APP_ID || "com.gigpulse.savvy").split(",").map((x) => x.trim()).filter(Boolean) },
  // SmartReply 用户绝大多数不会走进 PWA，用 PWA 侧口径只剩个位数（08-15 注册 12、IG绑定 0）。
  // 用户 2026-08-16 拍板：**SmartReply 单独用 AppsFlyer 口径**，衡量它自己应用内的漏斗
  // （安装 801 → 注册 471 → 应用选择 129 → IG任务 33）。代价是与另外三个产品不可横向比较。
  { key: "SmartReply", backend: "af", channelSplit: true, // AF 的 media_source 覆盖 98%+
    afAppIds: (process.env.SMARTREPLY_AF_APP_ID || "whisper.smart.reply").split(",").map((x) => x.trim()).filter(Boolean) },
];

// BytePlus 侧的产品区分（2026-08-16 用户提供字段名后重做）
//
// 【关键字段 pwa_app_name】事件属性，取值 savvy / smart_reply / null。BytePlus 界面里显示名是
// 「女用户 APP 名称」。**这是唯一能把四个产品在 BytePlus 里分开的字段**——在此之前只能靠 is_apk
// 近似，导致 PWA 的数字里混着 Savvy 等 APK 产品的量（见 git 历史）。
//   Savvy      = pwa_app_name='savvy'
//   SmartReply = pwa_app_name='smart_reply'
//   AI公会      = source ∈ AIguild*（用户属性，与 pwa_app_name 不重叠，实测公会用户的 pwa_app_name 为 null）
//   PWA 本体    = 全量 − 上面三者
export const PWA_APP_NAME_PROP = "pwa_app_name";
export const APP_NAME_VALUES = { Savvy: "savvy", SmartReply: "smart_reply" };
export const AIGUILD_SOURCES = ["AIguild", "AIguild_active", "AIguild_passive"];
export const SOURCE_TO_CHANNEL = { fb: "facebook", tt: "tiktok" };

// 后端 4 指标。BytePlus 口径直接复用 lib/key-metrics.mjs 的官方定义（那里逐字对齐了 BytePlus
// 「PWA 德州关键指标转化率看板」的报表配置），避免两处各写一份慢慢漂移。
//   注册     = pwa_conv_cash_ready_pop_show  UV
//   IG绑定   = pwa_task_complete + task_id=110  UV
//   GoLive分发 = pwa_conv_live_start_click（官方叫「可分发用户」）UV
//   成材     = pwa_withdraw_audit_apply + withdraw_amount=25  **PV(次数)** ← 官方关键指标就是次数
const km = (key) => {
  const m = KEY_METRICS.find((x) => x.key === key);
  if (!m) throw new Error(`lib/key-metrics.mjs 里找不到关键指标「${key}」——口径定义被改动了，请同步修 lib/xiaomei.mjs`);
  return m;
};

// afEvents：AF 事件候选，**按优先级排列**，取窗口内第一个有数据的。
// 每项 { name, amountEq? }：amountEq 会对 event_value->>'amount' 做数值相等过滤。
//   注册：Savvy 实测同时上报 af_complete_registration 与 pwa_conv_cash_ready_pop_show（同一批人、
//         条数相同），取前者即可；两个都没回传时该指标写 NULL（看板留空），**不拿 af_login_success
//         顶替**——那是「谷歌登录成功」，漏斗位置更靠前，混进来会把注册虚报（SmartReply 近 7 天
//         af_login_success 4185 vs IG绑定 383）。
//   成材：pwa_withdraw_audit_apply + amount=25，与 PWA/BytePlus 口径一致（amount=0.50 是首提，别混）。
//   IG绑定：SmartReply 用 af_complete_ins_task；Savvy 暂时没上报这个事件（2026-08-16 观察），
//         它有数据时会自动被接住，不用改代码。
export const BACKEND_METRICS = [
  // af_login_success 排在最后：它名字叫 login，但载荷带 af_registration_method=google，是 AF 的
  // 注册语义，且 SmartReply 的漏斗单调（装 801 > 它 471 > IG任务 33）。前两个候选有数时优先用前两个。
  { key: "register", label: "注册",      byteplus: km("register"),      afEvents: [{ name: "af_complete_registration" }, { name: "pwa_conv_cash_ready_pop_show" }, { name: "af_login_success" }] },
  { key: "ig_bind",  label: "IG绑定",    byteplus: km("ig_bind"),       afEvents: [{ name: "af_complete_ins_task" }] },
  { key: "golive",   label: "GoLive分发", byteplus: km("distributable"), afEvents: [{ name: "pwa_golive_enter" }] },
  { key: "chengcai", label: "成材",      byteplus: km("chengcai"),      afEvents: [{ name: "pwa_withdraw_audit_apply", amountEq: 25 }] },
];

export const BACKEND_KEYS = BACKEND_METRICS.map((m) => m.key);

// 业务库(DMS)取数 SQL。口径与 fetch-dms.mjs 的 PWA 口径逐条对齐，只把 app_name 换成目标产品，
// 便于两个产品的数字直接对比。dayExpr 由调用方注入（把 UTC 裸时间按目标时区切日）。
//   注册   = 建号行，且**有邮箱或手机**（过滤"建了号还没填资料"的空壳；PWA 侧同样处理，
//            2026-07-31 踩过：不过滤会把注册虚报近 3 倍）
//   IG绑定 = user_common_task task_id='110' AND status='FINISHED'（按完成时间 update_at）
//   成材   = user_withdraw_task amount='25'（按申请时间 create_at，不筛 status）
// ⚠️ task/withdraw 两张表是**全产品共用**的，必须 join userinfo 限定 app_name，否则串产品。
// ⚠️ task_id / amount 在业务库是 varchar，字面量必须带引号。
export const DMS_METRIC_SQL = {
  register: (app, day, from) =>
    `SELECT ${day("created_at")} AS d, count(*) AS n FROM userinfo
      WHERE app_name = '${app}' AND created_at >= '${from}'
        AND ((email IS NOT NULL AND email <> '') OR (phone_number IS NOT NULL AND phone_number <> ''))
      GROUP BY 1 ORDER BY 1`,
  ig_bind: (app, day, from) =>
    `SELECT ${day("t.update_at")} AS d, count(DISTINCT t.user_id) AS n
       FROM user_common_task t JOIN userinfo u ON u.user_id = t.user_id AND u.app_name = '${app}'
      WHERE t.task_id = '110' AND t.status = 'FINISHED' AND t.update_at >= '${from}'
      GROUP BY 1 ORDER BY 1`,
  chengcai: (app, day, from) =>
    `SELECT ${day("w.create_at")} AS d, count(*) AS n
       FROM user_withdraw_task w JOIN userinfo u ON u.user_id = w.user_id AND u.app_name = '${app}'
      WHERE w.amount = '25' AND w.create_at >= '${from}'
      GROUP BY 1 ORDER BY 1`,
};

// AF media_source → 渠道。AF 的取值形如 Facebook Ads / tiktokglobal_int / googleadwords_int；
// organic 与空值进「未归因」（自然量不属于任何投放渠道，但仍要计入产品总数）。
export function channelFromMediaSource(ms) {
  const s = String(ms || "").toLowerCase();
  if (!s) return UNATTRIBUTED;
  if (s.includes("facebook") || s.includes("meta")) return "facebook";
  if (s.includes("tiktok")) return "tiktok";
  if (s.includes("google") || s.includes("adwords")) return "google";
  return UNATTRIBUTED;
}

// XMP 侧产品归属 SQL 片段（与 spend-by-product.mjs 同源）：
//   AI公会 看**系列**白名单（它的账户在别的产品名下，只按账户归属会整个归错）；
//   其余看**账户**归属列：上架包(Savvy) → Savvy、上架包/SmartReply → SmartReply、其它 → PWA。
//   ⚠️ Savvy 必须排在 SmartReply 前面：归属值「上架包(Savvy)」两个模式都能命中。
export const PRODUCT_CASE_SQL = `
  CASE WHEN c.campaign_id IN (SELECT value FROM ai) THEN 'AI公会'
       WHEN a.grp ~* 'savvy'                        THEN 'Savvy'
       WHEN a.grp ~* '上架包|smart ?reply'           THEN 'SmartReply'
       ELSE 'PWA' END`;


// ═══════════════ Savvy 专属口径：BytePlus「当天注册」四指标 ═══════════════
// 用户 2026-08-19 给了 BytePlus 侧的 SQL，这里逐条对齐（SQL 原文见 git commit message）：
//
//   SELECT dt, count(distinct case when is_onboarding>=1 then user_unique_id end) AS onboarding_uv,
//                count(distinct case when is_sp_access  >=1 then user_unique_id end) AS sp_uv, …
//   FROM (… WHERE event_params.isTest='false' AND event_params.pwa_app_name='savvy'
//              AND is_new='当天注册' …)   -- is_new 由 dateDiff(reg_dt, dt)=0 决定
//
// 对应关系：
//   onboarding_uv       → register        事件 pwa_conv_cash_ready_pop_show 的去重人数
//   sp_uv               → ig_bind         事件 pwa_earning_ins_task_page_two_click 的去重人数
//   onboarding_beauty_uv→ beauty_register 上面那批人里 face_score>=70 的
//   sp_beauty_uv        → beauty_ig_bind  同上
//
// 【三个必须一起加的条件】少任何一个数就不对：
//   ① pwa_app_name = 'savvy'                          事件属性，四个产品在 BytePlus 里唯一的区分字段
//   ② isTest 排除测试                                  沿用 lib/byteplus.mjs 的官方写法（!= 'true'）
//   ③ 当天注册：user_register_time ∈ [当天00:00, 次日00:00)
//      ⚠️ 是**用户属性(profile)**、值为毫秒时间戳，不是事件属性，也不叫 $user_register_time
//         （2026-08-19 探针逐个试出来的）。这一条正是把「含回访老用户」的日 UV 变成「当日真实新增」
//         的关键 —— 08-15 实测：全量 133 → 当天注册 113 → 注册时间早于当天 12（差额 8 是没有注册
//         时间的用户，SQL 里落进 is_new='other'，同样被排除，两边一致）。
//      ⚠️ 这个区间是**绝对时间**，所以必须**一天一次查询**，不能一次查一个多天窗口。
//
// 【日界 Asia/Shanghai】与 SQL 一致（用户 2026-08-19 拍板）。注意这与本表其余部分的
// America/Chicago 日界**不同**：Savvy 这四个指标 + 成材/GoLive 不在同一个日界上，
// 跨产品横向比较时要知道这一点。好处是 XMP 的花费本来就是上海日，Savvy 的注册单价反而更准了。
// 【渠道拆分 channelProp】(2026-08-20 加)
// BytePlus 的**用户属性 media_source** 带真实归因值：tiktokglobal_int / Facebook+Ads /
// googleadwords_int（值是 URL 编码的，"Facebook+Ads" 的 + 是空格；channelFromMediaSource 能认）。
//   · 能和「当天注册」过滤、以及小美那两个漏斗**一起用**，分组求和 = 不分组的总数（实测差 ≤1 人）。
//   · 覆盖率逐日 70~90%（08-16 90% → 08-19 70%），剩下的是自然量/未归因，落「未归因」行。
//   · ⚠️ **只有 Savvy 有**：它是带 AF SDK 的 APK。PWA/AI公会 的这个属性整列为空
//     （实测全产品注册事件按 media_source 分组，(空)=555 里绝大多数就是它们）。
// ⚠️ 分组会**丢掉属性完全缺失的用户** → 各组之和可能比总数少几个。所以取数时**总量单独查一次**，
//    把 总量 − 各组之和 的残差补进「未归因」，保证产品合计与拆分前逐字一致。
export const SAVVY_BYTEPLUS = {
  timezone: process.env.SAVVY_BP_TIMEZONE || "Asia/Shanghai",
  channelProp: "media_source",
  appNameFilter: [{ property: PWA_APP_NAME_PROP, values: [APP_NAME_VALUES.Savvy] }],
  registerTimeProp: "user_register_time",   // profile，毫秒时间戳
  faceEvent: "pwa_user_face_score",
  faceScoreMin: 70,
  metrics: [
    { key: "register",        label: "注册",       event: "pwa_conv_cash_ready_pop_show" },
    { key: "ig_bind",         label: "IG绑定",     event: "pwa_earning_ins_task_page_two_click" },
    { key: "beauty_register", label: "小美注册",   event: "pwa_conv_cash_ready_pop_show",        beauty: true },
    { key: "beauty_ig_bind",  label: "小美IG绑定", event: "pwa_earning_ins_task_page_two_click", beauty: true },
  ],
};

// beauty_* 两列是**近似值，只会偏低**，看板/汇报里要按这个理解：
//   SQL 里的 is_beauty 是「同一个人当天还触发过 face_score>=70」——跨事件的同人条件。
//   BytePlus 事件分析接口表达不了它（2026-08-19 全部试过：option.fusion 两个事件仍是各算各的、
//   profile_filters 里塞行为条件报错、各种 unordered 开关被静默忽略），只有**有序漏斗**能做到，
//   于是取 漏斗[face_score>=70 → 目标事件]（同日窗口）的第二步人数。
//   代价：漏斗只算「先打分后触发」，反过来的人漏掉。08-15 实测 当天注册且 face>=70 的共 44 人，
//   漏斗给 42 → 真值落在 [42, 44]，偏低 ≤5%（人脸打分基本都发生在弹窗之前，所以缺口很小）。
//   要精确值只能走业务库 userinfo.face_score（那就不是 BytePlus 口径了）。
export const SAVVY_BEAUTY_NOTE = "小美两列=漏斗[face_score>=70→事件]近似，只会偏低(实测 ≤5%)";

// ═══ 与人工 SQL 的实测差异（2026-08-20 用户给了 08-15~08-18 的人工统计表逐日对了一遍）═══
//   花费 / 安装数    4/4 天**逐字一致** ✅（都来自 XMP，本来就是同一份数）
//   注册            -3 /  0 / +1 / -3   （08-15/16/17/18，占比 1~3%）
//   IG绑定          -1 / +1 /  0 / -1
//   小美注册        -3 /  0 / -1 / -2
//   小美IG绑定       0 /  0 /  0 / +1
//
// 【已排除的原因】逐个跑过对照，都不是：
//   · 测试用户写法：isTest!='true'（本脚本）/ isTest='false'（人工SQL）/ 再叠 profile is_test
//     / 完全不过滤 —— 前三种结果**完全相同**，证明两边等价。
//   · 去重口径：use_app_cloud_id true/false 结果相同。
//
// 【真正的原因，且改不了】人工 SQL 的「当天注册」读的是 **event_params.$user_register_time**
// （事件上带的注册时间），本脚本读的是**用户属性 user_register_time**（用户当前的注册时间）。
//   OpenAPI **根本拿不到 $ 开头的预置事件属性**：对照实验里 pwa_app_name 能正常分组(1 组)，
//   而 $user_register_time / $is_login 一律返回 0 组，profile 侧也没有 —— 只有不带 $ 的
//   user_register_time(profile) 有值(453 组)。所以只能用 profile 版。
//   两者的语义差：SQL 是「当天**任何一条事件**上带的注册时间 = 当天」，profile 是「这个人**现在**
//   的注册时间 = 当天」，同一批人里少数会落到不同的天 → 差异**双向**（有正有负），量级 1~3%。
//
// 【小美两列的漏斗近似实际上没造成额外损失】小美的差值几乎完全跟着注册的差值走
// （-3/0/-1/-2 对 -3/0/+1/-3），小美IG绑定 4 天里 3 天完全一致 —— 说明「先打分后触发」的
// 有序假设在真实数据里基本成立，之前估的 ≤5% 上限没有真的吃到。
//
// 【结论】这 1~3% 是接口能力的下界，不是 bug。要逐字对齐人工 SQL 只能走 BytePlus 的 SQL 查询
// （OpenAPI 未开放，2026-08-19 探过 /sql、/sql_query 等路径都不存在），或者去业务库自己算。

// 新增的两个指标也要有中文名，供日志/飞书表头复用
export const BEAUTY_METRICS = [
  { key: "beauty_register", label: "小美注册" },
  { key: "beauty_ig_bind",  label: "小美IG绑定" },
];
