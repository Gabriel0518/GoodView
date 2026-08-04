// 当前可用的 PWA facebook 广告账户（唯一事实源）。
// 被封的移除、新增的加这里——**改这一处**，广告组日报(daily-adgroup-report)和素材抓取(fetch-ads)都跟着变。
// 注意：这只控制「哪些账户进日报/素材分析」；主花费抓取范围另由飞书「XMP抓取配置」白名单控制，加账户两边都要加。
// ⚠️ 只放 PWA 账户。上架包(SmartReply)账户见 feishu-tables.mjs 的 APP_ACCOUNTS——那是另一个产品，
//    转化走 AppsFlyer 不走 BytePlus，混进来会让广告组日报按 PWA 口径给出错误的投放建议。
// name 可留空（新户还没在 XMP 出现过时）——导出前统一兜底成「账户xxxxxx」，
// 因为广告组日报会拿 name 建飞书单选项，多个空名字会撞成重复选项直接报错。
const RAW = [
  { id: "937843245746108",  name: "省广_pwa_新_4-ymt" },
  { id: "1971188246822953", name: "省广_pwa_新_5_zmf" }, // 2026-07-20 新增（替补被封的 zmf/3_ymt）
  { id: "2130069727853758", name: "省广_pwa_新_8_zmf" }, // 2026-07-22 新增，已在投（近7天 $2432）
  { id: "7582874867184386064", name: "省广_GC AND_5-zmf（pwa）" }, // 2026-07-22 新增 TikTok 渠道（渠道由 XMP module 判定）
  { id: "7408482788221173761", name: "省广_GC AND_1-ymt（pwa）" }, // 2026-07-24 新增 TikTok 渠道
  { id: "1073224918490287", name: "省广_pwa_新_9_zmf" },  // 2026-07-27 新增 FB 渠道
  { id: "2422172414972759", name: "省广_pwa_新_10_ymt" }, // 2026-07-27 新增 FB 渠道
  // 2026-07-30 新建的 3 个 TikTok 账户（07-31 开投），已核对系列名全是 PWA-*
  { id: "7639625690962640914", name: "省广_GC_pwa_1_zmf" },
  { id: "7639625025477623815", name: "省广_GC_pwa_2_wcx" },
  { id: "7639625716434485256", name: "省广_GC AND_6_ymt(pwa)" },
  // 2026-08-03 新建的 10 个 TikTok 账户（08-04 开投）。
  // ⚠️ 这批混着 PWA 和 Savvy：08-04 开投后按系列名确认，4 个是 Savvy（省广_Savvyand_*，
  //    系列 Savvy_syh_260804_USA_1 / test Texas / test USA）已移到「上架包(Savvy)」归属，
  //    见下方移除记录。剩下 6 个还没花费、拿不到账户名，暂按 PWA 挂着；
  //    它们一开投就跑 `node check-account-group.mjs` 复核，别忘了。
  { id: "7668624339939524616", name: "" },
  { id: "7668624955337752594", name: "" },
  { id: "7668625354855022600", name: "" },
  { id: "7668624339939590152", name: "" },
  { id: "7668624396474679303", name: "" },
  { id: "7668625448309424136", name: "" },
  // 2026-08-04 移除 4 个 Savvy 账户（当初整批按 PWA 挂进来，开投后系列名证明是 Savvy）：
  //   7668625504119832584（省广_Savvyand_1-syh，08-04 花费 $204.53）
  //   7668625452341477383（省广_Savvyand_2-syh，$10.03）
  //   7668625286317195282（省广_Savvyand_3-syh，$9.70）
  //   7668624954805305352（省广_Savvyand_5-syh，$0.77）
  // 花费照抓，归「上架包渠道日报」，不进 PWA 口径（它们的转化在 AF 不在 BytePlus）。
  // 2026-07-24 移除 827391417005980（省广_pwa_新_6_ymt，已被封）
  // 2026-07-29 移除 3 个上架包(SmartReply)账户——当初按名字误当成 PWA 账户加进来，实际投的是应用商店安装包：
  //   6245583421（AI Fantasy-T8088，google，SR_android_wcx_install_0724_gg）
  //   27589868840681799（省广_SR_and_5_wcx，facebook，Smart Reply_android_wcx_install_0725）
  //   7665547836257058834（省广_SR_and_1-5D80，tiktok，Smart Reply-test）
  // 花费仍照抓（XMP抓取配置里保留），只是归「上架包渠道日报」，不进 PWA 口径。
];

export const ACTIVE_PWA_ACCOUNTS = RAW.map((a) => ({ ...a, name: a.name || `账户${a.id.slice(-6)}` }));

export const ACTIVE_PWA_ACCOUNT_IDS = ACTIVE_PWA_ACCOUNTS.map((a) => a.id);
