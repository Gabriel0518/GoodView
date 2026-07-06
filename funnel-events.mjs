// PWA + AI公会通道 完整转化漏斗事件表（来源：BytePlus「PWA 转化率看板」）
// 指标口径：总人数 UV = event_users（去重人数）
// 部分事件复用同一 event_name，靠属性过滤区分（如 pwa_task_complete + task_id）
// source 维度：AIguild_active(主动入站/直发) / AIguild_passive(被动入站/留咨) / AIguild(公会整体)
//
// filters 里的属性过滤 = 该阶段必须叠加的条件；无 filters 的事件直接按 event_name 取即可。
// name 后带 ⚠️ 的是 PDF 里被截断、需跑数验证的事件名（取不到数就是名字要改）。

export const FUNNEL = [
  { key: "lp_show",              label: "投广页曝光",            name: "pwa_conv_lp_show" },
  { key: "lp_click",             label: "投广页点击",            name: "pwa_conv_lp_clickButton" },
  { key: "banner_show",          label: "权益页曝光",            name: "pwa_conv_banner1_show" },
  { key: "install_show",         label: "安装页曝光",            name: "pwa_conv_install_web_show" },
  { key: "install_click",        label: "安装页点击",            name: "pwa_conv_install_web_clickButton" },
  { key: "install_pop_show",     label: "安装PWA弹窗",           name: "pwa_conv_install_web_pop_show" },
  { key: "install_pop_agree",    label: "安装PWA弹窗同意",       name: "pwa_conv_install_web_pop_clickButton" },
  { key: "install_success",      label: "安装成功",              name: "web_install_success" },
  { key: "login_page",           label: "谷歌登录页",            name: "web_login_page_show" },
  { key: "login_click",          label: "点击谷歌登录",          name: "pwa_login_click" },
  { key: "set_name",             label: "名字页曝光",            name: "pwa_conv_set_name_show" },
  { key: "set_age",              label: "年龄页曝光",            name: "pwa_conv_set_age_show" },
  { key: "photo_page",           label: "照片页曝光",            name: "pwa_onboarding_photo_page_show" },
  { key: "photo_crop",           label: "照片裁剪页曝光",        name: "pwa_reg_photo_requirement_modal_show" },
  { key: "phone_page",           label: "电话页曝光",            name: "pwa_conv_phone_page_show" },
  { key: "phone_confirm",        label: "电话确认弹窗曝光",      name: "pwa_onboarding_phone_confirm_modal_show" },
  { key: "cash_ready_show",      label: "0.5刀提现弹窗-注册完成", name: "pwa_conv_cash_ready_pop_show" },
  { key: "cash_ready_click",     label: "0.5刀提现弹窗点击",     name: "pwa_conv_cash_ready_pop_clickButton" },
  { key: "paypal_show",          label: "Enter Paypal页曝光",    name: "pwa_cashout_accountpage_show" },
  { key: "paypal_confirm",       label: "Enter Paypal页点击",    name: "pwa_cashout_accountpage_confirm" },
  { key: "withdraw_first",       label: "第一笔提现任务完成弹窗", name: "pwa_withdraw_audit_apply", filters: [{ property: "withdraw_amount", values: ["0.5"] }] },
  { key: "cash_success",         label: "第一笔提现成功弹窗",     name: "pwa_conv_cash_success_page_show" },
  { key: "video_rules_show",     label: "视频规则弹窗",          name: "pwa_conv_video_rules_pop_show" },
  { key: "video_rules_next",     label: "视频规则弹窗2",         name: "pwa_conv_video_rules_next1_click" },
  { key: "mock_show",            label: "mock video show",       name: "pwa_receive_call_request" },
  { key: "mock_connect",         label: "mock video connect",    name: "pwa_video_call_connecting_show", filters: [{ property: "router", values: ["%2Fmock-call"] }] },
  { key: "mock_result",          label: "mock video result",     name: "pwa_test_video_result" },
  { key: "mock_earn",            label: "mock video earn",       name: "pwa_waiting_reward_show", filters: [{ property: "source", values: ["mock_call"] }] },
  { key: "home_show",            label: "Home页曝光",            name: "pwa_home_page_show" },
  { key: "live_tab_click",       label: "点击Live Tab",          name: "pwa_home_tab_click", filters: [{ property: "tab", values: ["live"] }] },
  { key: "live_show",            label: "Live页曝光",            name: "pwa_live_page_show" },
  { key: "live_go",              label: "Live页 Go Live",        name: "pwa_conv_live_start_click" },
  { key: "apk_task_click",       label: "下载apk任务点击",       name: "pwa_home_cash_task_click", filters: [{ property: "task_id", values: ["112", "102", "103"] }] },
  { key: "apk_pop_click",        label: "下载apk浮层点击",       name: "pwa_conv_download_apk_pop_clickButton" },
  { key: "task_camera",          label: "摄像头权限任务完成",    name: "pwa_task_complete", filters: [{ property: "task_id", values: ["102"] }] },
  { key: "task_mic",            label: "麦克风权限任务完成",    name: "pwa_task_complete", filters: [{ property: "task_id", values: ["103"] }] },
  { key: "task_location",        label: "位置权限任务完成",      name: "pwa_task_complete", filters: [{ property: "task_id", values: ["105"] }] },
  { key: "task_2_1",             label: "2.1刀任务完成",         name: "pwa_task_complete", filters: [{ property: "task_id", values: ["200001"] }] },
  { key: "task_apk_install",     label: "安装APK任务完成",       name: "pwa_task_complete", filters: [{ property: "task_id", values: ["112"] }] },
  { key: "apk_open",             label: "在APK打开应用",         name: "pwa_page_view", filters: [{ property: "is_apk", values: ["true"] }] },
  { key: "task_realperson",      label: "真人验证任务完成",      name: "pwa_task_complete", filters: [{ property: "task_id", values: ["118"] }] },
  { key: "withdraw_task2",       label: "完成任务2(提现)",       name: "pwa_withdraw_audit_apply", filters: [{ property: "withdraw_amount", values: ["4", "7", "5.5"] }] },
  { key: "ins_auth_show",        label: "Ins授权浮层曝光",       name: "pwa_social_media_login_show" },
  { key: "ins_auth_click",       label: "Ins授权浮层点击",       name: "pwa_ins_login_button_click" },
  { key: "task_ins_bind",        label: "绑定Ins任务完成(IG授权)", name: "pwa_task_complete", filters: [{ property: "task_id", values: ["110"] }] },
  { key: "ins_auth_success",     label: "Ins授权回调-授权成功",  name: "pwa_earning_ins_task_page_two_click" },
  { key: "device_perm",          label: "授予设备浮层权限",      name: "pwa_afk_sys_request_pop_up_click" },
];

// 全局细分（看板里对齐用，可选）：排除测试用户 + 仅新用户
export const GLOBAL_FILTERS = [
  { property: "is_test", op: "neq", values: ["true", ""] },
  { property: "isTest", op: "neq", values: ["true"] },
  // 新老用户 = 新用户（属性名/取值待确认）
];

// 我们要拆的 source（主动/被动/整体）
export const SOURCES = ["AIguild_active", "AIguild_passive", "AIguild"];
