// 飞书镜像表的单一事实源：字段定义（建表用）+ Postgres 读取 SQL + 行→飞书字段映射（同步用）。
// feishu-init-tables.mjs 与 sync-to-feishu.mjs 都读这里，保证结构与写入一致、不漂移。
//
// 两类表：
//   windowed=true  按日期窗口镜像：靠 date_num(整数 YYYYMMDD) 做窗口删除+重灌（对齐 Postgres 的 DELETE+INSERT）。
//   windowed=false 配置类小表：全量替换（清空后重灌）。
import { FT, dateMs, dateNum } from "./lib/feishu.mjs";
import { FEISHU } from "./config.mjs";
import { loadAdGroups, resolveGroupToCampaignIds } from "./lib/groups.mjs";
import { query } from "./lib/db.mjs";

// 单选字段种子选项（新值写入时飞书会自动补建，这里只给已知值配色）
const seed = (names) => ({ options: names.map((name, i) => ({ name, color: i % 10 })) });
const CHANNELS = ["facebook", "tiktok", "google"];
const SOURCES = ["fb", "tt", "bff", "AIguild", "AIguild_active", "AIguild_passive", "google", "unknown"];

const num = (v) => (v == null ? 0 : Number(v));
const jstr = (v) => (v == null ? "" : typeof v === "string" ? v : JSON.stringify(v));

const adsetGrain = FEISHU.campaignGrain === "adset";

// ---- campaign_daily：广告投放日报（默认系列粒度；FEISHU_CAMPAIGN_GRAIN=adset 则含广告组明细）----
const campaignFields = [
  { field_name: "标识", type: FT.TEXT }, // 主字段=自然键，保证唯一可读
  { field_name: "日期", type: FT.DATE },
  { field_name: "date_num", type: FT.NUMBER },
  { field_name: "账户ID", type: FT.TEXT },
  { field_name: "账户名", type: FT.TEXT },
  { field_name: "渠道", type: FT.SINGLE_SELECT, property: seed(CHANNELS) },
  { field_name: "系列ID", type: FT.TEXT },
  { field_name: "系列名", type: FT.TEXT },
  ...(adsetGrain ? [
    { field_name: "广告组ID", type: FT.TEXT },
    { field_name: "广告组名", type: FT.TEXT },
  ] : []),
  { field_name: "花费", type: FT.NUMBER },
  { field_name: "曝光", type: FT.NUMBER },
  { field_name: "点击", type: FT.NUMBER },
];

const campaignTable = {
  key: "campaign_daily",
  name: "广告投放日报",
  windowed: true,
  fields: campaignFields,
  sql: (from, to) =>
    adsetGrain
      ? {
          text: `SELECT to_char(date,'YYYY-MM-DD') AS date, account_id, account_name, channel,
                         campaign_id, campaign_name, adset_id, adset_name,
                         cost::float8 AS cost, impression, click
                  FROM campaign_daily WHERE date BETWEEN $1 AND $2
                    AND (cost > 0 OR impression > 0 OR click > 0)
                  ORDER BY date DESC`,
          params: [from, to],
        }
      : {
          text: `SELECT to_char(date,'YYYY-MM-DD') AS date, account_id, MAX(account_name) AS account_name, channel,
                         campaign_id, MAX(campaign_name) AS campaign_name,
                         SUM(cost)::float8 AS cost, SUM(impression)::bigint AS impression, SUM(click)::bigint AS click
                  FROM campaign_daily WHERE date BETWEEN $1 AND $2
                    AND (cost > 0 OR impression > 0 OR click > 0)
                  GROUP BY date, account_id, channel, campaign_id
                  ORDER BY date DESC`,
          params: [from, to],
        },
  toFields: (r) => ({
    标识: adsetGrain
      ? `${r.date}|${r.account_id}|${r.campaign_id}|${r.adset_id}`
      : `${r.date}|${r.account_id}|${r.campaign_id}`,
    日期: dateMs(r.date),
    date_num: dateNum(r.date),
    账户ID: r.account_id,
    账户名: r.account_name || "",
    渠道: r.channel || "",
    系列ID: r.campaign_id,
    系列名: r.campaign_name || "",
    ...(adsetGrain ? { 广告组ID: r.adset_id, 广告组名: r.adset_name || "" } : {}),
    花费: num(r.cost),
    曝光: num(r.impression),
    点击: num(r.click),
  }),
};

// ---- funnel_daily：转化漏斗日报 ----
const funnelTable = {
  key: "funnel_daily",
  name: "转化漏斗日报",
  windowed: true,
  fields: [
    { field_name: "标识", type: FT.TEXT },
    { field_name: "日期", type: FT.DATE },
    { field_name: "date_num", type: FT.NUMBER },
    { field_name: "阶段Key", type: FT.TEXT },
    { field_name: "阶段名", type: FT.TEXT },
    { field_name: "阶段序号", type: FT.NUMBER },
    { field_name: "来源", type: FT.SINGLE_SELECT, property: seed(SOURCES) },
    { field_name: "人数", type: FT.NUMBER },
  ],
  sql: (from, to) => ({
    text: `SELECT to_char(f.date,'YYYY-MM-DD') AS date, f.stage_key, MAX(m.label) AS label, MAX(m.ord) AS ord,
                   f.source, SUM(f.count)::bigint AS count
            FROM funnel_daily f JOIN funnel_stage_meta m ON m.stage_key = f.stage_key
            WHERE f.date BETWEEN $1 AND $2 AND f.count > 0
            GROUP BY f.date, f.stage_key, f.source
            ORDER BY f.date DESC`,
    params: [from, to],
  }),
  toFields: (r) => ({
    标识: `${r.date}|${r.stage_key}|${r.source}`,
    日期: dateMs(r.date),
    date_num: dateNum(r.date),
    阶段Key: r.stage_key,
    阶段名: r.label || "",
    阶段序号: num(r.ord),
    来源: r.source || "",
    人数: num(r.count),
  }),
};

// ---- ig_auth_daily：IG授权日报 ----
const igTable = {
  key: "ig_auth_daily",
  name: "IG授权日报",
  windowed: true,
  fields: [
    { field_name: "日期文本", type: FT.TEXT },
    { field_name: "日期", type: FT.DATE },
    { field_name: "date_num", type: FT.NUMBER },
    { field_name: "IG授权人数", type: FT.NUMBER },
  ],
  sql: (from, to) => ({
    text: `SELECT to_char(date,'YYYY-MM-DD') AS date, count FROM ig_auth_daily WHERE date BETWEEN $1 AND $2`,
    params: [from, to],
  }),
  toFields: (r) => ({
    日期文本: r.date,
    日期: dateMs(r.date),
    date_num: dateNum(r.date),
    IG授权人数: num(r.count),
  }),
};

// ---- funnel_stage_meta：漏斗阶段定义（全量替换）----
const stageMetaTable = {
  key: "funnel_stage_meta",
  name: "漏斗阶段定义",
  windowed: false,
  fields: [
    { field_name: "阶段Key", type: FT.TEXT },
    { field_name: "顺序", type: FT.NUMBER },
    { field_name: "显示名", type: FT.TEXT },
    { field_name: "事件名", type: FT.TEXT },
    { field_name: "过滤", type: FT.TEXT },
    { field_name: "启用", type: FT.CHECKBOX },
    { field_name: "按来源拆", type: FT.CHECKBOX },
    { field_name: "指标", type: FT.TEXT },
    { field_name: "状态", type: FT.TEXT },
  ],
  sql: () => ({
    text: `SELECT stage_key, ord, label, event_name, filters, enabled, source_split, indicator, status
            FROM funnel_stage_meta ORDER BY ord`,
    params: [],
  }),
  toFields: (r) => ({
    阶段Key: r.stage_key,
    顺序: num(r.ord),
    显示名: r.label || "",
    事件名: r.event_name || "",
    过滤: jstr(r.filters),
    启用: !!r.enabled,
    按来源拆: !!r.source_split,
    指标: r.indicator || "",
    状态: r.status || "",
  }),
};

// ---- ad_groups：广告分组（全量替换）----
const adGroupsTable = {
  key: "ad_groups",
  name: "广告分组",
  windowed: false,
  fields: [
    { field_name: "分组名", type: FT.TEXT },
    { field_name: "分组ID", type: FT.NUMBER },
    { field_name: "成员数", type: FT.NUMBER },
    { field_name: "App组", type: FT.CHECKBOX },
    { field_name: "成员", type: FT.TEXT },
  ],
  sql: () => ({
    text: `SELECT id, name, members, is_app_group, jsonb_array_length(members) AS member_count
            FROM ad_groups ORDER BY id`,
    params: [],
  }),
  toFields: (r) => ({
    分组名: r.name || "",
    分组ID: num(r.id),
    成员数: num(r.member_count),
    App组: !!r.is_app_group,
    成员: jstr(r.members),
  }),
};

export const DATE_NUM_FIELD = "date_num";

// ==================== XMP抓取配置（配置表 A，反向：飞书 → Postgres）====================
// 单表两类行，用「类别」列区分：广告账户/广告系列（抓取范围·白名单）+ 指标（抓哪些字段）。
// 用户在飞书填；sync-config-from-feishu.mjs 读它、校验、覆盖 xmp_fetch_config、回写状态。
// 唯一「飞书为权威、DB 为镜像」的反向表 —— 故【不】进 TABLES（不被 sync-to-feishu 推送覆盖），
// 只由 feishu-init-tables 建表、sync-config 反向消费。类别/落库层做成下拉；值为主字段(文本)靠校验+回写兜错。
export const xmpConfigTable = {
  key: "xmp_fetch_config",
  name: "XMP抓取配置",
  reverse: true,
  F: { value: "值", category: "类别", name: "名称", layer: "落库层", enabled: "启用", status: "状态" },
  fields: [
    { field_name: "值", type: FT.TEXT }, // 主字段：账户ID/系列ID（或其名称）或 指标（曝光/impression）
    { field_name: "类别", type: FT.SINGLE_SELECT, property: seed(["广告账户", "广告系列", "指标"]) },
    { field_name: "名称", type: FT.TEXT }, // 可读备注（账户/系列名；指标可留空）
    { field_name: "落库层", type: FT.SINGLE_SELECT, property: seed(["core", "ext"]) }, // 仅「指标」行用
    { field_name: "启用", type: FT.CHECKBOX },
    { field_name: "状态", type: FT.TEXT }, // 脚本回写：✅ / ❌ 原因
  ],
};

export const CONFIG_TABLES = [xmpConfigTable];

// ---- AI公会日报（派生：广告分组「PWA AI公会」花费 ÷ AI公会来源人数，按日 join）----
// 花费 = 2 系列(0630_web_text 直发 + 0617_Customer Form_1 留咨)。
// 人数口径随日期切换（用户确认）：2026-07-03 前 source='AIguild' 为总口径；此后拆为 active+passive。
// 单价 = 花费 / 人数（人数为 0 则单价留空，区分「无」与「0」）。跨立方已在此 join 好，飞书仪表盘直接用。
// AI公会系列：0630_web_text(直发) + 0617_Customer Form_1(留咨) 于 2026-07-14 停投；
// 自 07-14 换成 0714_Customer Form_and(安卓) + _Ios(iOS)。四个都保留 → 花费历史连续（旧的只有 07-14 前、新的只有 07-14 后）。
const AIGUILD_CAMPAIGNS = ["120248092167100162", "120251189845320085", "120252738947370085", "120252739540850085"];
const AIGUILD_SPLIT_DATE = "2026-07-03";
const AIGUILD_STAGES = { reg: "cash_ready_show", wd: "withdraw_first", ig: "task_ins_bind", cc: "chengcai" };
// AI公会分端(安卓/iOS)：花费按系列归端；人数按 os 归端(aiguild_os_daily)。
// 2026-07-14 起分端投放：_and=安卓、_Ios=iOS。旧系列(07-14前)未分端 → 不计入分端花费(分端只看 07-14 后)。
const AIGUILD_OS_CAMPAIGNS = {
  android: ["120252738947370085"], // 0714_Customer Form_and
  ios:     ["120252739540850085"], // 0714_Customer Form_Ios
};
const price = (cost, n) => (n > 0 ? Math.round((cost / n) * 100) / 100 : undefined);

const aiguildTable = (campaigns) => ({
  key: "aiguild_daily",
  name: "AI公会日报",
  windowed: true,
  fields: [
    { field_name: "标识", type: FT.TEXT },
    { field_name: "日期", type: FT.DATE },
    { field_name: "date_num", type: FT.NUMBER },
    { field_name: "花费", type: FT.NUMBER },
    { field_name: "注册人数", type: FT.NUMBER },
    { field_name: "注册单价", type: FT.NUMBER },
    { field_name: "首提人数", type: FT.NUMBER },
    { field_name: "首提单价", type: FT.NUMBER },
    { field_name: "IG授权人数", type: FT.NUMBER },
    { field_name: "IG授权单价", type: FT.NUMBER },
    { field_name: "成材人数", type: FT.NUMBER },
    { field_name: "成材单价", type: FT.NUMBER },
  ],
  sql: (from, to) => ({
    text: `
      WITH d AS (SELECT generate_series($1::date,$2::date,'1 day')::date date),
      spend AS (SELECT date, SUM(cost)::float8 cost FROM campaign_daily
                WHERE campaign_id = ANY($3) AND date BETWEEN $1 AND $2 GROUP BY date),
      ppl AS (
        SELECT date,
          SUM(count) FILTER (WHERE stage_key=$4) reg,
          SUM(count) FILTER (WHERE stage_key=$5) wd,
          SUM(count) FILTER (WHERE stage_key=$6) ig,
          SUM(count) FILTER (WHERE stage_key=$7) cc
        FROM funnel_daily
        WHERE date BETWEEN $1 AND $2 AND stage_key IN ($4,$5,$6,$7)
          AND ((date <  DATE '${AIGUILD_SPLIT_DATE}' AND source = 'AIguild')
            OR (date >= DATE '${AIGUILD_SPLIT_DATE}' AND source IN ('AIguild_active','AIguild_passive')))
        GROUP BY date)
      SELECT to_char(d.date,'YYYY-MM-DD') date, COALESCE(s.cost,0) cost,
             COALESCE(p.reg,0) reg, COALESCE(p.wd,0) wd, COALESCE(p.ig,0) ig, COALESCE(p.cc,0) cc
      FROM d LEFT JOIN spend s ON s.date=d.date LEFT JOIN ppl p ON p.date=d.date
      WHERE COALESCE(s.cost,0)>0 OR COALESCE(p.reg,0)>0 OR COALESCE(p.wd,0)>0
         OR COALESCE(p.ig,0)>0 OR COALESCE(p.cc,0)>0
      ORDER BY d.date DESC`,
    params: [from, to, campaigns,
             AIGUILD_STAGES.reg, AIGUILD_STAGES.wd, AIGUILD_STAGES.ig, AIGUILD_STAGES.cc],
  }),
  toFields: (r) => {
    const cost = num(r.cost), reg = num(r.reg), wd = num(r.wd), ig = num(r.ig), cc = num(r.cc);
    const f = {
      标识: r.date, 日期: dateMs(r.date), date_num: dateNum(r.date),
      花费: cost, 注册人数: reg, 首提人数: wd, IG授权人数: ig, 成材人数: cc,
    };
    const rp = price(cost, reg), wp = price(cost, wd), ip = price(cost, ig), cp = price(cost, cc);
    if (rp !== undefined) f.注册单价 = rp;
    if (wp !== undefined) f.首提单价 = wp;
    if (ip !== undefined) f.IG授权单价 = ip;
    if (cp !== undefined) f.成材单价 = cp;
    return f;
  },
});

// ---- AI公会汇总（3 行：近7日/近14日/近30日 各自的加权汇总，供指标卡取精确加权单价 = SUM花费/SUM人数）----
// 指标卡的 rollup 无法算 SUM/SUM 比值，故在此 SQL 里按周期算好；卡片按「口径」过滤到某周期后取 MAX(1 行) 即得精确值。
const aiguildSummaryTable = (campaigns) => ({
  key: "aiguild_summary",
  name: "AI公会汇总",
  windowed: true,
  fields: [
    { field_name: "口径", type: FT.TEXT },
    { field_name: "排序", type: FT.NUMBER },
    { field_name: "花费", type: FT.NUMBER },
    { field_name: "注册人数", type: FT.NUMBER },
    { field_name: "注册单价", type: FT.NUMBER },
    { field_name: "首提人数", type: FT.NUMBER },
    { field_name: "首提单价", type: FT.NUMBER },
    { field_name: "IG授权人数", type: FT.NUMBER },
    { field_name: "IG授权单价", type: FT.NUMBER },
    { field_name: "成材人数", type: FT.NUMBER },
    { field_name: "成材单价", type: FT.NUMBER },
  ],
  sql: (from, to) => {
    // 「今日」行锚 to(今天)；「近N日」行锚 to-1(昨天，完整日)。人数口径随 2026-07-03 切换。
    const ppl = (stage) =>
      `(SELECT COALESCE(SUM(count),0) FROM funnel_daily
        WHERE date > $2::date - pr.ao - pr.days AND date <= $2::date - pr.ao AND stage_key='${stage}'
          AND ((date <  DATE '${AIGUILD_SPLIT_DATE}' AND source = 'AIguild')
            OR (date >= DATE '${AIGUILD_SPLIT_DATE}' AND source IN ('AIguild_active','AIguild_passive'))))`;
    return {
      text: `
        SELECT pr.label AS caliber, pr.ord AS ord,
          (SELECT COALESCE(SUM(cost),0)::float8 FROM campaign_daily
           WHERE campaign_id = ANY($1) AND date > $2::date - pr.ao - pr.days AND date <= $2::date - pr.ao) AS cost,
          ${ppl(AIGUILD_STAGES.reg)} AS reg,
          ${ppl(AIGUILD_STAGES.wd)}  AS wd,
          ${ppl(AIGUILD_STAGES.ig)}  AS ig,
          ${ppl(AIGUILD_STAGES.cc)}  AS cc
        FROM (VALUES (0::int,0::int,1::int,'今日'),(1,1,1,'近1日'),(7,1,7,'近7日'),(14,1,14,'近14日'),(30,1,30,'近30日')) pr(ord,ao,days,label)
        ORDER BY pr.ord`,
      params: [campaigns, to],
    };
  },
  toFields: (r) => {
    const cost = num(r.cost), reg = num(r.reg), wd = num(r.wd), ig = num(r.ig), cc = num(r.cc);
    const f = { 口径: r.caliber, 排序: num(r.ord), 花费: cost, 注册人数: reg, 首提人数: wd, IG授权人数: ig, 成材人数: cc };
    const rp = price(cost, reg), wp = price(cost, wd), ip = price(cost, ig), cp = price(cost, cc);
    if (rp !== undefined) f.注册单价 = rp;
    if (wp !== undefined) f.首提单价 = wp;
    if (ip !== undefined) f.IG授权单价 = ip;
    if (cp !== undefined) f.成材单价 = cp;
    return f;
  },
});

// ---- AI公会分端汇总（安卓/iOS × 周期）：花费按系列归端，人数按 os 归端(aiguild_os_daily)----
// 分端投放自 2026-07-14 起。数据量小(个位数/天)，故只出周期行(今日/近1/7/14/30日)，别按天看。
const aiguildOsSummaryTable = () => ({
  key: "aiguild_os_summary",
  name: "AI公会分端汇总",
  windowed: true,
  fields: [
    { field_name: "端", type: FT.SINGLE_SELECT, property: { options: [{ name: "安卓", color: 1 }, { name: "iOS", color: 3 }] } },
    { field_name: "口径", type: FT.TEXT },
    { field_name: "排序", type: FT.NUMBER },
    { field_name: "花费", type: FT.NUMBER },
    { field_name: "注册人数", type: FT.NUMBER },
    { field_name: "注册单价", type: FT.NUMBER },
    { field_name: "首提人数", type: FT.NUMBER },
    { field_name: "首提单价", type: FT.NUMBER },
    { field_name: "IG授权人数", type: FT.NUMBER },
    { field_name: "IG授权单价", type: FT.NUMBER },
    { field_name: "成材人数", type: FT.NUMBER },
    { field_name: "成材单价", type: FT.NUMBER },
  ],
  sql: (from, to) => {
    // os → (campaign 集合, os 桶名)；两端各出 5 个周期行。os 桶 = aiguild_os_daily.os。
    const ppl = (stage) =>
      `(SELECT COALESCE(SUM(count),0) FROM aiguild_os_daily
        WHERE date > $1::date - pr.ao - pr.days AND date <= $1::date - pr.ao AND stage_key='${stage}' AND os = e.osbucket)`;
    return {
      text: `
        SELECT e.label AS side, pr.label AS caliber, (e.so*100 + pr.ord) AS ord,
          (SELECT COALESCE(SUM(cost),0)::float8 FROM campaign_daily
           WHERE campaign_id = ANY(e.camps) AND date > $1::date - pr.ao - pr.days AND date <= $1::date - pr.ao) AS cost,
          ${ppl(AIGUILD_STAGES.reg)} AS reg,
          ${ppl(AIGUILD_STAGES.wd)}  AS wd,
          ${ppl(AIGUILD_STAGES.ig)}  AS ig,
          ${ppl(AIGUILD_STAGES.cc)}  AS cc
        FROM (VALUES
          (0::int,'安卓','android'::text, $2::text[]),
          (1::int,'iOS','ios'::text,     $3::text[])
        ) e(so,label,osbucket,camps)
        CROSS JOIN (VALUES (0::int,0::int,1::int,'今日'),(1,1,1,'近1日'),(7,1,7,'近7日'),(14,1,14,'近14日'),(30,1,30,'近30日')) pr(ord,ao,days,label)
        ORDER BY ord`,
      params: [to, AIGUILD_OS_CAMPAIGNS.android, AIGUILD_OS_CAMPAIGNS.ios],
    };
  },
  toFields: (r) => {
    const cost = num(r.cost), reg = num(r.reg), wd = num(r.wd), ig = num(r.ig), cc = num(r.cc);
    const f = { 端: r.side, 口径: r.caliber, 排序: num(r.ord), 花费: cost, 注册人数: reg, 首提人数: wd, IG授权人数: ig, 成材人数: cc };
    const rp = price(cost, reg), wp = price(cost, wd), ip = price(cost, ig), cp = price(cost, cc);
    if (rp !== undefined) f.注册单价 = rp;
    if (wp !== undefined) f.首提单价 = wp;
    if (ip !== undefined) f.IG授权单价 = ip;
    if (cp !== undefined) f.成材单价 = cp;
    return f;
  },
});

// ===== PWA 非公会渠道（花费=若干 facebook 账户全部系列；人数=非公会来源 fb/tt/bff/unknown，即排除 AIguild 三桶，无日期切换）=====
// 账户列表现从 ad_groups(is_app_group=true) 动态取（见 resolveDerivedGroups）；下方为兜底默认。
const PWA_ACCOUNTS = ["864750783313841", "2236726820405499"]; // 省广_pwa_3_ymt_新, 省广_pwa_新_1_zmf
const PWA_ACCOUNT_NAMES = ["省广_pwa_3_ymt_新", "省广_pwa_新_1_zmf"];
const PWA_PPL_SOURCE = `source NOT IN ('AIguild','AIguild_active','AIguild_passive')`;

// 单账户系列日报表：date × 系列 花费/曝光/点击（过滤全 0 行）
const pwaAccountTable = (name, accId) => ({
  key: `acct_${accId}`,
  name,
  windowed: true,
  fields: [
    { field_name: "标识", type: FT.TEXT },
    { field_name: "日期", type: FT.DATE },
    { field_name: "date_num", type: FT.NUMBER },
    { field_name: "系列ID", type: FT.TEXT },
    { field_name: "系列名", type: FT.TEXT },
    { field_name: "花费", type: FT.NUMBER },
    { field_name: "曝光", type: FT.NUMBER },
    { field_name: "点击", type: FT.NUMBER },
  ],
  sql: (from, to) => ({
    text: `SELECT to_char(date,'YYYY-MM-DD') AS date, campaign_id, MAX(campaign_name) AS campaign_name,
                   SUM(cost)::float8 AS cost, SUM(impression)::bigint AS impression, SUM(click)::bigint AS click
            FROM campaign_daily WHERE account_id = $1 AND date BETWEEN $2 AND $3
              AND (cost > 0 OR impression > 0 OR click > 0)
            GROUP BY date, campaign_id ORDER BY date DESC`,
    params: [accId, from, to],
  }),
  toFields: (r) => ({
    标识: `${r.date}|${r.campaign_id}`,
    日期: dateMs(r.date), date_num: dateNum(r.date),
    系列ID: r.campaign_id, 系列名: r.campaign_name || "",
    花费: num(r.cost), 曝光: num(r.impression), 点击: num(r.click),
  }),
});

// ===== 上架包（SmartReply APP）=====
// 与 PWA 是两个产品：投的是应用商店安装包，转化走 AppsFlyer（af_events），不在 BytePlus 的 PWA 应用里。
// 所以这些账户的花费**必须**从 PWA 看板剔除——否则分母有花费、分子永远没转化，会把 PWA 单价整体抬高
// （2026-07-29 发现时已污染 4 天、$942：Google $483 + TikTok $381 + Facebook $78，且不止 Google 行，
//  TikTok/Facebook 行也被抬高）。剔除逻辑见 resolveDerivedGroups，与「公会账户自动排除」同款。
// 加/减上架包账户改这里一处：既决定「上架包渠道日报」算谁，也决定从 PWA 看板剔除谁。
// 已核对（2026-07-29）：三个账户各只有一条 SmartReply 系列，无 PWA 系列混投，可整账户切走。
const APP_ACCOUNTS = [
  { id: "6245583421",          name: "AI Fantasy-T8088",   channel: "google" },   // SR_android_wcx_install_0724_gg
  { id: "7665547836257058834", name: "省广_SR_and_1-5D80", channel: "tiktok" },   // Smart Reply-test
  { id: "27589868840681799",   name: "省广_SR_and_5_wcx",  channel: "facebook" }, // Smart Reply_android_wcx_install_0725
];
const APP_ACCOUNT_IDS = APP_ACCOUNTS.map((a) => a.id);

// 上架包渠道日报（date × 渠道，结构对齐 PWA渠道日报，便于两个产品横向对比）：
//   花费 = campaign_daily 上架包账户 按 channel（XMP）
//   人数 = af_events join af_event_map（AF Push 实时推来的原始事件），只统计 enabled 的阶段
//          当前启用：安装(install) / 注册(af_login_success)；IG授权(af_complete_ins_task) 暂不同步
//   ⚠️ 人数按「设备数」而非事件次数——注册类事件同一设备可重复触发。
//      设备标识用回退链 appsflyer_id → advertising_id(GAID) → idfa → android_id → dedupe_key：
//      appsflyer_id 在 AF 的 Push API 里是**可选字段**，没勾就不发（2026-07-29 实测就没发，
//      只发了 advertising_id）。写死用 appsflyer_id 会让人数恒为 0，故必须回退。
//      最后兜底 dedupe_key = 每行算一个，宁可退化成事件次数，也不要静默变 0。
//   ⚠️ AF 的 event_time 是 UTC，这里转 Asia/Shanghai 取业务日，与 XMP 花费/BytePlus 漏斗的日期口径对齐。
const appDailyTable = () => ({
  key: "app_daily",
  name: "上架包渠道日报",
  windowed: true,
  fields: [
    { field_name: "标识", type: FT.TEXT },
    { field_name: "日期", type: FT.DATE },
    { field_name: "date_num", type: FT.NUMBER },
    { field_name: "渠道", type: FT.SINGLE_SELECT, property: { options: [{ name: "Facebook", color: 1 }, { name: "TikTok", color: 3 }, { name: "Google", color: 5 }, { name: "自然量", color: 6 }, { name: "其他", color: 7 }] } },
    { field_name: "渠道名称", type: FT.TEXT },
    { field_name: "花费", type: FT.NUMBER },
    { field_name: "安装数", type: FT.NUMBER },
    { field_name: "安装单价", type: FT.NUMBER },
    { field_name: "注册数", type: FT.NUMBER },
    { field_name: "注册单价", type: FT.NUMBER },
  ],
  sql: (from, to) => ({
    text: `
      WITH d AS (SELECT generate_series($1::date,$2::date,'1 day')::date date),
      ch(label,channel,so) AS (VALUES ('Facebook','facebook',0),('TikTok','tiktok',1),('Google','google',2),('自然量','',3),('其他','',4)),
      spend AS (SELECT date, channel, SUM(cost)::float8 cost FROM campaign_daily
                WHERE account_id = ANY($3) AND date BETWEEN $1 AND $2 GROUP BY date, channel),
      ppl AS (
        -- AF 的 media_source 各媒体写法不一（googleadwords_int / Facebook Ads / bytedanceglobal_int …）
        -- 且会随 AF 版本变，故用模糊匹配而不是等值枚举，避免改名就漏数。
        SELECT (e.event_time AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::date AS date,
          CASE
            WHEN e.media_source ILIKE '%google%'                                    THEN 'Google'
            WHEN e.media_source ILIKE '%facebook%' OR e.media_source ILIKE '%meta%' THEN 'Facebook'
            WHEN e.media_source ILIKE '%tiktok%'  OR e.media_source ILIKE '%bytedance%' THEN 'TikTok'
            WHEN e.media_source IS NULL OR e.media_source IN ('organic','Organic')  THEN '自然量'
            ELSE '其他'
          END AS label,
          COUNT(DISTINCT COALESCE(e.appsflyer_id, e.advertising_id, e.idfa, e.android_id, e.dedupe_key))
            FILTER (WHERE m.stage_key = 'app_install')  AS installs,
          COUNT(DISTINCT COALESCE(e.appsflyer_id, e.advertising_id, e.idfa, e.android_id, e.dedupe_key))
            FILTER (WHERE m.stage_key = 'app_register') AS regs
        FROM af_events e
        JOIN af_event_map m ON m.af_event_name = e.event_name AND m.enabled
        WHERE (e.event_time AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::date BETWEEN $1 AND $2
        GROUP BY 1, 2)
      SELECT to_char(d.date,'YYYY-MM-DD') date, ch.label channel, ch.so so, COALESCE(s.cost,0) cost,
             COALESCE(p.installs,0) installs, COALESCE(p.regs,0) regs
      FROM d CROSS JOIN ch
      LEFT JOIN spend s ON s.date=d.date AND s.channel=ch.channel
      LEFT JOIN ppl   p ON p.date=d.date AND p.label=ch.label
      WHERE COALESCE(s.cost,0)>0 OR COALESCE(p.installs,0)>0 OR COALESCE(p.regs,0)>0
      ORDER BY d.date DESC, ch.so`,
    params: [from, to, APP_ACCOUNT_IDS],
  }),
  toFields: (r) => {
    const cost = num(r.cost), inst = num(r.installs), reg = num(r.regs);
    const f = { 标识: `${r.date}|${r.channel}`, 日期: dateMs(r.date), date_num: dateNum(r.date),
      渠道: r.channel, 渠道名称: r.channel, 花费: cost, 安装数: inst, 注册数: reg };
    // 单价仅在有花费时给出；自然量行无花费(0) → 留空，避免 $0 误导（与 PWA 表同款处理）。
    if (cost > 0) {
      const ip = price(cost, inst), rp = price(cost, reg);
      if (ip !== undefined) f.安装单价 = ip;
      if (rp !== undefined) f.注册单价 = rp;
    }
    return f;
  },
});

// PWA渠道日报（date × 渠道 Facebook/TikTok/Google/Bff/其他，按日分渠道看）：
//   花费按 campaign_daily.channel、人数按 funnel source（渠道↔source：facebook↔fb、tiktok↔tt、google↔google、Bff↔bff）。
//   Bff 无广告账户 → 花费恒 0、单价留空（自然量渠道，只看人数）；「其他」= 归不到上述来源的（主要是 unknown）。
//   ⚠️ AI公会不进本表（source 三桶被排除，花费另在「AI公会转化观测」看板算），故渠道之和 = 大盘非公会总量。
const pwaDailyTable = (accounts) => ({
  key: "pwa_daily",
  name: "PWA渠道日报",
  windowed: true,
  fields: [
    { field_name: "标识", type: FT.TEXT },
    { field_name: "日期", type: FT.DATE },
    { field_name: "date_num", type: FT.NUMBER },
    { field_name: "渠道", type: FT.SINGLE_SELECT, property: { options: [{ name: "Facebook", color: 1 }, { name: "TikTok", color: 3 }, { name: "Google", color: 5 }, { name: "Bff", color: 6 }, { name: "其他", color: 7 }] } },
    // 渠道名称：与「渠道」同值的纯文本镜像（单选在公式/文本维度场景不好用，这里给一份可直接引用的文本）。
    { field_name: "渠道名称", type: FT.TEXT },
    { field_name: "花费", type: FT.NUMBER },
    { field_name: "注册人数", type: FT.NUMBER },
    { field_name: "注册单价", type: FT.NUMBER },
    { field_name: "首提人数", type: FT.NUMBER },
    { field_name: "首提单价", type: FT.NUMBER },
    { field_name: "IG授权人数", type: FT.NUMBER },
    { field_name: "IG授权单价", type: FT.NUMBER },
    { field_name: "成材人数", type: FT.NUMBER },
    { field_name: "成材单价", type: FT.NUMBER },
  ],
  sql: (from, to) => ({
    text: `
      WITH d AS (SELECT generate_series($1::date,$2::date,'1 day')::date date),
      ch(label,channel,so) AS (VALUES ('Facebook','facebook',0),('TikTok','tiktok',1),('Google','google',2),('Bff','',3),('其他','',4)),
      spend AS (SELECT date, channel, SUM(cost)::float8 cost FROM campaign_daily
                WHERE account_id = ANY($3) AND date BETWEEN $1 AND $2 GROUP BY date, channel),
      ppl AS (
        -- 人数按 funnel source 归到渠道；非公会里归不到 fb/tt/google/bff 的（unknown 等）落「其他」，
        -- 保证渠道之和 = 大盘非公会总量（此前只 join fb/tt/google，丢了 bff+unknown 约半数）。
        SELECT date,
          CASE source WHEN 'fb' THEN 'Facebook' WHEN 'tt' THEN 'TikTok' WHEN 'google' THEN 'Google'
                      WHEN 'bff' THEN 'Bff' ELSE '其他' END AS label,
          SUM(count) FILTER (WHERE stage_key=$4) reg,
          SUM(count) FILTER (WHERE stage_key=$5) wd,
          SUM(count) FILTER (WHERE stage_key=$6) ig,
          SUM(count) FILTER (WHERE stage_key=$7) cc
        FROM funnel_daily
        WHERE date BETWEEN $1 AND $2 AND stage_key IN ($4,$5,$6,$7)
          AND source NOT IN ('AIguild','AIguild_active','AIguild_passive')
        GROUP BY date, label)
      SELECT to_char(d.date,'YYYY-MM-DD') date, ch.label channel, ch.so so, COALESCE(s.cost,0) cost,
             COALESCE(p.reg,0) reg, COALESCE(p.wd,0) wd, COALESCE(p.ig,0) ig, COALESCE(p.cc,0) cc
      FROM d CROSS JOIN ch
      LEFT JOIN spend s ON s.date=d.date AND s.channel=ch.channel
      LEFT JOIN ppl p ON p.date=d.date AND p.label=ch.label
      WHERE COALESCE(s.cost,0)>0 OR COALESCE(p.reg,0)>0 OR COALESCE(p.wd,0)>0
         OR COALESCE(p.ig,0)>0 OR COALESCE(p.cc,0)>0
      ORDER BY d.date DESC, ch.so`,
    params: [from, to, accounts, AIGUILD_STAGES.reg, AIGUILD_STAGES.wd, AIGUILD_STAGES.ig, AIGUILD_STAGES.cc],
  }),
  toFields: (r) => {
    const cost = num(r.cost), reg = num(r.reg), wd = num(r.wd), ig = num(r.ig), cc = num(r.cc);
    const f = { 标识: `${r.date}|${r.channel}`, 日期: dateMs(r.date), date_num: dateNum(r.date), 渠道: r.channel, 渠道名称: r.channel,
      花费: cost, 注册人数: reg, 首提人数: wd, IG授权人数: ig, 成材人数: cc };
    // 单价仅在有花费时给出；Bff/「其他」行无广告花费(0) → 单价留空，避免 $0 误导。
    if (cost > 0) {
      const rp = price(cost, reg), wp = price(cost, wd), ip = price(cost, ig), cp = price(cost, cc);
      if (rp !== undefined) f.注册单价 = rp;
      if (wp !== undefined) f.首提单价 = wp;
      if (ip !== undefined) f.IG授权单价 = ip;
      if (cp !== undefined) f.成材单价 = cp;
    }
    return f;
  },
});

// PWA渠道汇总（4 行：近1/7/14/30 日加权汇总，结构同 AI公会汇总）
const pwaSummaryTable = (accounts) => ({
  key: "pwa_summary",
  name: "PWA渠道汇总",
  windowed: true,
  fields: [
    { field_name: "口径", type: FT.TEXT },
    { field_name: "排序", type: FT.NUMBER },
    { field_name: "花费", type: FT.NUMBER },
    { field_name: "注册人数", type: FT.NUMBER },
    { field_name: "注册单价", type: FT.NUMBER },
    { field_name: "首提人数", type: FT.NUMBER },
    { field_name: "首提单价", type: FT.NUMBER },
    { field_name: "IG授权人数", type: FT.NUMBER },
    { field_name: "IG授权单价", type: FT.NUMBER },
    { field_name: "成材人数", type: FT.NUMBER },
    { field_name: "成材单价", type: FT.NUMBER },
  ],
  sql: (from, to) => {
    // 「今日」行锚 to(今天)；「近N日」行锚 to-1(昨天，完整日)。用 pr.ao(锚偏移) 区分。
    const ppl = (stage) =>
      `(SELECT COALESCE(SUM(count),0) FROM funnel_daily
        WHERE date > $2::date - pr.ao - pr.days AND date <= $2::date - pr.ao AND stage_key='${stage}' AND ${PWA_PPL_SOURCE})`;
    return {
      text: `
        SELECT pr.label AS caliber, pr.ord AS ord,
          (SELECT COALESCE(SUM(cost),0)::float8 FROM campaign_daily
           WHERE account_id = ANY($1) AND date > $2::date - pr.ao - pr.days AND date <= $2::date - pr.ao) AS cost,
          ${ppl(AIGUILD_STAGES.reg)} AS reg,
          ${ppl(AIGUILD_STAGES.wd)}  AS wd,
          ${ppl(AIGUILD_STAGES.ig)}  AS ig,
          ${ppl(AIGUILD_STAGES.cc)}  AS cc
        FROM (VALUES (0::int,0::int,1::int,'今日'),(1,1,1,'近1日'),(7,1,7,'近7日'),(14,1,14,'近14日'),(30,1,30,'近30日')) pr(ord,ao,days,label)
        ORDER BY pr.ord`,
      params: [accounts, to],
    };
  },
  toFields: (r) => {
    const cost = num(r.cost), reg = num(r.reg), wd = num(r.wd), ig = num(r.ig), cc = num(r.cc);
    const f = { 口径: r.caliber, 排序: num(r.ord), 花费: cost, 注册人数: reg, 首提人数: wd, IG授权人数: ig, 成材人数: cc };
    const rp = price(cost, reg), wp = price(cost, wd), ip = price(cost, ig), cp = price(cost, cc);
    if (rp !== undefined) f.注册单价 = rp;
    if (wp !== undefined) f.首提单价 = wp;
    if (ip !== undefined) f.IG授权单价 = ip;
    if (cp !== undefined) f.成材单价 = cp;
    return f;
  },
});

const retentionTable = (key, name, category) => ({
  key, name, windowed: false,
  fields: [
    { field_name: "报表", type: FT.TEXT },
    { field_name: "排序", type: FT.NUMBER },
    { field_name: "当日人数", type: FT.NUMBER },
    { field_name: "次日留存率", type: FT.NUMBER },
    { field_name: "3日留存率", type: FT.NUMBER },
    { field_name: "7日留存率", type: FT.NUMBER },
    { field_name: "14日留存率", type: FT.NUMBER },
    { field_name: "30日留存率", type: FT.NUMBER },
  ],
  sql: () => ({
    text: `SELECT report_name, ord, base_users, r_d1, r_d3, r_d7, r_d14, r_d30
            FROM retention_summary WHERE category = $1 ORDER BY ord`,
    params: [category],
  }),
  toFields: (r) => {
    const f = { 报表: r.report_name, 排序: num(r.ord), 当日人数: num(r.base_users) };
    const add = (k, v) => { if (v !== null && v !== undefined) f[k] = Number(v); };
    add("次日留存率", r.r_d1); add("3日留存率", r.r_d3); add("7日留存率", r.r_d7);
    add("14日留存率", r.r_d14); add("30日留存率", r.r_d30);
    return f;
  },
});
const retentionUser = retentionTable("retention_user", "用户留存", "user");
const retentionChengcai = retentionTable("retention_chengcai", "成材女留存", "chengcai");

// 从 ad_groups / 抓取配置解析派生看板的账户/系列集合。找不到配置时回退到写死的默认值，保证行为不变。
//   AI公会 = 名称含「AI公会/AIguild/公会」的分组 → 展开为 campaign_id 集合（花费按系列过滤）。
//   PWA(非公会)看板账户 = 「XMP抓取配置」里 category='account' 的账户行，自动排除拥有公会系列的账户
//                        （即 AI公会 campaign 所属账户，如 pwa-2026-02）→ 与公会口径不重复。花费按账户过滤。
//   → 你只在抓取配置里维护「广告账户」列表，加/减账户即改看板，无需额外类别；公会账户自动不算进 PWA。
// 注意：人数口径层（AIGUILD_SPLIT_DATE 日期切换、PWA_PPL_SOURCE 反向 source）不来自配置，保持写死。
async function resolveDerivedGroups() {
  let groups = [];
  try { groups = await loadAdGroups(); } catch { groups = []; }
  const byName = (kw) => groups.find((g) => g.name.includes(kw));

  // AI公会系列集合
  let aiguildCampaigns = AIGUILD_CAMPAIGNS;
  const aiG = byName("AI公会") || byName("AIguild") || byName("公会");
  if (aiG) {
    try {
      const ids = await resolveGroupToCampaignIds(aiG.members);
      if (ids.length) aiguildCampaigns = ids;
    } catch { /* 保留默认 */ }
  }

  // PWA(非公会)看板账户集（[{id,name}]）：抓取配置的 account 行 − 公会账户 − 无花费账户，回退写死默认。
  let pwaAccounts = PWA_ACCOUNTS.map((id, i) => ({ id, name: PWA_ACCOUNT_NAMES[i] || id }));
  try {
    const { rows: accRows } = await query(
      `SELECT value, name FROM xmp_fetch_config WHERE category = 'account' AND enabled = true`,
    );
    if (accRows.length) {
      // 公会账户 = 拥有任一 AI公会 campaign 的账户（自动排除，避免与公会看板重复计花费）
      const { rows: gAcc } = await query(
        `SELECT DISTINCT account_id FROM campaign_daily WHERE campaign_id = ANY($1::text[])`,
        [aiguildCampaigns],
      );
      const guildAccIds = new Set(gAcc.map((r) => r.account_id));
      // account 行的「值」可填 id 或名称 → 解析成规范 {id, name}，并带近 60 天花费（过滤空账户，免建空表）
      const vals = accRows.map((r) => r.value);
      const { rows: acc } = await query(
        `SELECT account_id, MAX(account_name) AS account_name,
                COALESCE(SUM(cost) FILTER (WHERE date > CURRENT_DATE - 60), 0)::float8 AS recent_cost
           FROM campaign_daily
          WHERE account_id = ANY($1::text[]) OR account_name = ANY($1::text[])
          GROUP BY account_id`,
        [vals],
      );
      const nameById = new Map(acc.map((a) => [a.account_id, a.account_name]));
      const idByName = new Map(acc.map((a) => [a.account_name, a.account_id]));
      const spendById = new Set(acc.filter((a) => a.recent_cost > 0).map((a) => a.account_id));
      const seen = new Set();
      const resolved = [];
      for (const r of accRows) {
        let id, nm;
        if (nameById.has(r.value)) { id = r.value; nm = nameById.get(r.value); }
        else if (idByName.has(r.value)) { id = idByName.get(r.value); nm = r.value; }
        else continue;                        // 填的值在库里查无此账户 → 跳过（无数据可展示）
        if (guildAccIds.has(id)) continue;     // 排除公会账户（花费归公会看板）
        if (APP_ACCOUNT_IDS.includes(id)) continue; // 排除上架包账户（花费归「上架包渠道日报」；
                                               // 它们的转化在 AF 不在 BytePlus，留在这儿会永远是「有花费零转化」）
        if (!spendById.has(id)) continue;     // 排除近 60 天零花费账户（免建空的账户系列表）
        if (seen.has(id)) continue;
        seen.add(id);
        resolved.push({ id, name: r.name || nm || id });
      }
      if (resolved.length) pwaAccounts = resolved;
    }
  } catch { /* 读配置失败 → 保留默认 */ }

  return { aiguildCampaigns, pwaAccounts };
}

// 构建全部镜像表（含从 ad_groups 动态解析的派生看板）。异步：需先查库解析分组。
// 静态表(campaign/funnel/ig/stageMeta/adGroups/retention)不依赖分组，直接列出。
export async function buildTables() {
  const g = await resolveDerivedGroups();
  const pwaAccIds = g.pwaAccounts.map((a) => a.id);
  return [
    campaignTable,
    funnelTable,
    igTable,
    stageMetaTable,
    adGroupsTable,
    aiguildTable(g.aiguildCampaigns),
    aiguildSummaryTable(g.aiguildCampaigns),
    aiguildOsSummaryTable(),
    ...g.pwaAccounts.map((a) => pwaAccountTable(a.name, a.id)),
    pwaDailyTable(pwaAccIds),
    pwaSummaryTable(pwaAccIds),
    appDailyTable(),
    retentionUser,
    retentionChengcai,
  ];
}
