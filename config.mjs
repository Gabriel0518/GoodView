// 集中配置 —— 密钥从环境变量读取。
// 本地：从 ./.env 加载（gitignore）；云端(Railway)：平台注入环境变量。
// 非密钥项（gateway/host/timezone/默认值）内联，无需配置。
try { process.loadEnvFile(); } catch { /* 无 .env（如云端）时忽略，用平台环境变量 */ }

const env = process.env;

export const DATABASE_URL = env.DATABASE_URL || "";

export const XMP = {
  gateway: env.XMP_GATEWAY || "https://xmp-open.mobvista.com",
  clientId: env.XMP_CLIENT_ID || "",
  clientSecret: env.XMP_CLIENT_SECRET || "",
};

export const BYTEPLUS = {
  host: env.BYTEPLUS_HOST || "https://analytics.byteplusapi.com",
  ak: env.BYTEPLUS_AK || "",
  sk: env.BYTEPLUS_SK || "",
  appId: Number(env.BYTEPLUS_APP_ID || 653834),
  igAuthEvent: env.BYTEPLUS_IG_AUTH_EVENT || "pwa_ins_login_button_click",
  // 时区口径：2026-07 起 BytePlus 项目时区改为 Asia/Shanghai，与 XMP(上海) 对齐 → 漏斗不再比花费滞后 1 天。
  // （历史上曾锚 US/Eastern 以对齐官方报表；官方已迁上海，故这里同步改。数据口径-BytePlus计算方法.md §3 的 ET 时间戳仅影响 report 类回补，另行处理。）
  timezone: env.BYTEPLUS_TIMEZONE || "Asia/Shanghai",
};

export const SETTINGS = {
  defaultLookbackDays: Number(env.PULL_DEFAULT_DAYS || 30), // 默认拉最近 N 个完整日（不含今天）
  currency: env.CURRENCY || "USD",
};

// 飞书多维表格同步（Postgres → Bitable 单向镜像，供飞书仪表盘搭建）。
// 未配置 appToken 时，同步整体跳过（pull-all 不受影响）。
export const FEISHU = {
  host: env.FEISHU_HOST || "https://open.feishu.cn",
  appId: env.FEISHU_APP_ID || "",           // 自建应用 App ID
  appSecret: env.FEISHU_APP_SECRET || "",   // 自建应用 App Secret
  appToken: env.FEISHU_APP_TOKEN || "",     // 目标多维表格（Base）的 app_token
  // 同步窗口：每次只**更新**最近 N 天（窗口外的历史行保留在飞书，不删）。Postgres 仍是全量权威库。
  syncDays: Number(env.FEISHU_SYNC_DAYS || 30),
  // 飞书单表行数上限（本 tenant 2 万硬限）。留一档余量做安全线：增量累积顶到这条线时，
  // 同步会自动裁掉最旧的行腾地方（并打日志说明裁了多少、裁到哪天），避免 1254103 RecordExceedLimit
  // 直接把同步打挂。想多留历史就把这个值调高（≤20000），或改小 syncDays 降低单次写入量。
  maxRows: Number(env.FEISHU_MAX_ROWS || 19000),
  // campaign_daily 粒度：campaign（按系列聚合，行数少，默认）| adset（含广告组明细，行数多）。
  campaignGrain: (env.FEISHU_CAMPAIGN_GRAIN || "campaign").toLowerCase() === "adset" ? "adset" : "campaign",
};
