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
  timezone: env.BYTEPLUS_TIMEZONE || "Asia/Shanghai",
};

export const SETTINGS = {
  defaultLookbackDays: Number(env.PULL_DEFAULT_DAYS || 30), // 默认拉最近 N 个完整日（不含今天）
  currency: env.CURRENCY || "USD",
};
