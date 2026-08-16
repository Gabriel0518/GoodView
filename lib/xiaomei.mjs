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
//   afAppIds：AppsFlyer 的 app_id（af_events.app_id）。Savvy 留空 = 数据源未接 → 后端指标写 NULL。
export const PRODUCTS = [
  { key: "PWA",        backend: "byteplus", byteplusScope: "pwa" },
  { key: "AI公会",      backend: "byteplus", byteplusScope: "aiguild" },
  { key: "Savvy",      backend: "af", afAppIds: (process.env.SAVVY_AF_APP_ID || "").split(",").map((s) => s.trim()).filter(Boolean) },
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

// afEvents：AF 事件名候选，**按优先级排列**，取窗口内第一个有数据的。
//   注册：用户 2026-08-16 说明上架包会上报 af_complete_registration（也可能是 pwa_conv_cash_ready_pop_show）；
//         两个都没回传时该指标写 NULL（看板留空），不拿 af_login_success 顶替——那是「谷歌登录成功」，
//         漏斗位置更靠前，混进来会把注册虚报（近 7 天 4185 vs IG绑定 383）。
//   成材：AF 侧没有对应事件（上架包没有提现链路）→ 候选留空 = 永远 NULL。
export const BACKEND_METRICS = [
  { key: "register", label: "注册",      byteplus: km("register"),      afEvents: ["af_complete_registration", "pwa_conv_cash_ready_pop_show"] },
  { key: "ig_bind",  label: "IG绑定",    byteplus: km("ig_bind"),       afEvents: ["af_complete_ins_task"] },
  { key: "golive",   label: "GoLive分发", byteplus: km("distributable"), afEvents: ["pwa_golive_enter"] },
  { key: "chengcai", label: "成材",      byteplus: km("chengcai"),      afEvents: [] },
];

export const BACKEND_KEYS = BACKEND_METRICS.map((m) => m.key);

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
