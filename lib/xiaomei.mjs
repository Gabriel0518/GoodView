// 「小美投放转化」看板的口径定义（唯一事实源）。fetch-xiaomei.mjs 与 feishu-tables.mjs 都读这里。
//
// 一行数据 = 日期 × 产品 × 渠道。四个产品的后端转化分散在三套系统里，这个文件把映射关系集中管理：
//   PWA / AI公会  → BytePlus DataRangers（app 653834，靠用户属性 source 区分两者）
//   SmartReply    → AppsFlyer（Push API 实时推进我们自己的 af_events 表）
//   Savvy         → AppsFlyer，但**AF 后台还没配 Push 端点** → 填 SAVVY_AF_APP_ID 后自动生效
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
// 【Savvy 为什么走 DMS】(2026-08-16 查证)
//   · BytePlus **区分不出 Savvy**：它的 APK 内嵌的就是 PWA，打的是同一套 pwa_* 埋点、进的是同一个
//     app(653834)，source 取值里没有 savvy（只有 tt/fb/bff/AIguild*/smart_reply）→ 它的量混在 tt/fb 里。
//     ⚠️ 连带影响：本表的 PWA = 全量−AI公会，**因此 PWA 的后端数字里混着 Savvy 的量**，见 README 提示。
//   · 业务库能精确切出来：Savvy 的 12 个业务 user_id 100% 命中 userinfo 且 **app_name=32**
//     （独立于 PWA 的 app_name=3）。历史从 08-07 起完整，比 AF 更全（AF 的 Push 端点 08-16 才开始推）。
//     这也解开了 fetch-dms.mjs 里那条悬案注释：「07-31 起 app_name=32 这个新产品也产生 task_id=110」
//     —— 那个"新产品"就是 Savvy。
//   · GoLive 业务库没有（PWA 同样没有，pwa_distribution 未接）→ 走 AF 的 pwa_golive_enter，
//     它带 media_source 所以有渠道；DMS 那三个指标没有渠道维度 → 落「未归因」行。
export const PRODUCTS = [
  { key: "PWA",        backend: "byteplus", byteplusScope: "pwa" },
  { key: "AI公会",      backend: "byteplus", byteplusScope: "aiguild" },
  { key: "Savvy",      backend: "af",
    afAppIds: (process.env.SAVVY_AF_APP_ID || "com.gigpulse.savvy").split(",").map((s) => s.trim()).filter(Boolean),
    dmsAppName: process.env.SAVVY_DMS_APP_NAME || "32",
    dmsMetrics: ["register", "ig_bind", "chengcai"] },
  { key: "SmartReply", backend: "af", afAppIds: (process.env.SMARTREPLY_AF_APP_ID || "whisper.smart.reply").split(",").map((s) => s.trim()).filter(Boolean) },
];

// BytePlus 侧 source 取值 → 产品。AIguild / AIguild_active / AIguild_passive 是**互不重叠**的三个
// 字面量取值（2026-08-16 核对近 5 日注册：1 / 0 / 15，不是「整体=主动+被动」的包含关系）→ 三者相加
// 才是 AI公会 全量。fb / tt 是 PWA 的广告来源，同时也是渠道标识。
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
