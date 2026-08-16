// 「小美投放转化」看板的口径定义（唯一事实源）。fetch-xiaomei.mjs 与 feishu-tables.mjs 都读这里。
//
// 一行数据 = 日期 × 产品 × 渠道。
//   投放侧(花费/曝光/点击/安装) → XMP（读库里的 campaign_daily + campaign_metric_daily）
//   后端(注册/IG绑定/GoLive/成材) → **BytePlus 一家**，四个产品用同一事件、同一口径，
//     靠事件属性 pwa_app_name 区分（见下方 PWA_APP_NAME_PROP 注释）
//   AppsFlyer(af_events) 与业务库(DMS) 现在只作交叉验证，不进本表 —— 2026-08-16 之前它们是主源，
//     那时还没找到 pwa_app_name，四个产品被迫分散在三套系统里、口径互不可比。
//
// 【日界】统一按 America/Chicago 切日 —— 芝加哥的一天 = 北京 13:00 ~ 次日 13:00（夏令时；
// 冬令时是 14:00~14:00，Intl 会自动跟随，不用改代码）。这正是用户要的「用前一日 13:00 到第二日
// 13:00 对齐 XMP 昨日整日」。XMP 侧日期本身按上海日切，两边**不重切、只做 D↔D 标签对齐**
// （为什么不重切花费：XMP 没有小时维度，timezone 参数被静默忽略；完整论证见 lib/key-metrics.mjs）。
import { KEY_METRICS } from "./key-metrics.mjs";

export const XIAOMEI_TIMEZONE = process.env.XIAOMEI_TIMEZONE || "America/Chicago";

// 渠道：XMP 的 module 三值 + 一个「未归因」兜底行（后端指标拆不到渠道时的去处）
export const CHANNELS = ["facebook", "tiktok", "google"];
export const UNATTRIBUTED = "未归因";
export const ALL_CHANNELS = [...CHANNELS, UNATTRIBUTED];

// 产品。backend 决定后端 4 指标从哪取；顺序即看板展示顺序。
//   afAppIds：AppsFlyer 的 app_id（af_events.app_id）。
//   dmsAppName + dmsMetrics：从自有业务库(archat)按 userinfo.app_name 取的指标。
//
// 【历史】2026-08-16 当天曾把 Savvy 改走业务库(app_name=32)、PWA 改走业务库(app_name=3)，
// 因为当时以为 BytePlus 分不出产品。拿到 pwa_app_name 后全部回归 BytePlus。
// 业务库那套口径（建号行、每人一次）仍然有价值：它是「当日真实新增」，而 BytePlus 的日 UV 是
// 「当日看到弹窗的人」含回访老用户，实测前者约为后者的 60~85%。要对账时用 fetch-dms.mjs。
export const PRODUCTS = [
  { key: "PWA",        backend: "byteplus", byteplusScope: "pwa" },
  { key: "AI公会",      backend: "byteplus", byteplusScope: "aiguild" },
  { key: "Savvy",      backend: "byteplus", byteplusScope: "appName",
    afAppIds: (process.env.SAVVY_AF_APP_ID || "com.gigpulse.savvy").split(",").map((x) => x.trim()).filter(Boolean) },
  { key: "SmartReply", backend: "byteplus", byteplusScope: "appName",
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
  { key: "register", label: "注册",      byteplus: km("register"),      afEvents: [{ name: "af_complete_registration" }, { name: "pwa_conv_cash_ready_pop_show" }] },
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
