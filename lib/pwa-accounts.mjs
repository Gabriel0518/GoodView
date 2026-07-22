// 当前可用的 PWA facebook 广告账户（唯一事实源）。
// 被封的移除、新增的加这里——**改这一处**，广告组日报(daily-adgroup-report)和素材抓取(fetch-ads)都跟着变。
// 注意：这只控制「哪些账户进日报/素材分析」；主花费抓取范围另由飞书「XMP抓取配置」白名单控制，加账户两边都要加。
export const ACTIVE_PWA_ACCOUNTS = [
  { id: "937843245746108",  name: "省广_pwa_新_4-ymt" },
  { id: "1971188246822953", name: "省广_pwa_新_5_zmf" }, // 2026-07-20 新增（替补被封的 zmf/3_ymt）
  { id: "827391417005980",  name: "省广_pwa_新_6_ymt" }, // 2026-07-22 新增
  { id: "2130069727853758", name: "省广_pwa_新_8" },      // 2026-07-22 新增（尚未投放，名字待用户确认）
  { id: "7582874867184386064", name: "省广_GC AND_5-zmf（pwa）" }, // 2026-07-22 新增 TikTok 渠道（渠道由 XMP module 判定）
];

export const ACTIVE_PWA_ACCOUNT_IDS = ACTIVE_PWA_ACCOUNTS.map((a) => a.id);
