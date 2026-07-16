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
    { field_name: "类别", type: FT.SINGLE_SELECT, property: seed(["广告账户", "广告系列", "指标", "PWA看板账户"]) },
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
const AIGUILD_CAMPAIGNS = ["120248092167100162", "120251189845320085"];
const AIGUILD_SPLIT_DATE = "2026-07-03";
const AIGUILD_STAGES = { reg: "cash_ready_show", wd: "withdraw_first", ig: "task_ins_bind", cc: "chengcai" };
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
    // 每指标一个相关子查询，按 pr.days 滚动窗口（锚定 to=昨天）；人数口径随 2026-07-03 切换。
    const ppl = (stage) =>
      `(SELECT COALESCE(SUM(count),0) FROM funnel_daily
        WHERE date > $2::date - pr.days AND date <= $2::date AND stage_key='${stage}'
          AND ((date <  DATE '${AIGUILD_SPLIT_DATE}' AND source = 'AIguild')
            OR (date >= DATE '${AIGUILD_SPLIT_DATE}' AND source IN ('AIguild_active','AIguild_passive'))))`;
    return {
      text: `
        SELECT pr.label AS caliber, pr.days AS ord,
          (SELECT COALESCE(SUM(cost),0)::float8 FROM campaign_daily
           WHERE campaign_id = ANY($1) AND date > $2::date - pr.days AND date <= $2::date) AS cost,
          ${ppl(AIGUILD_STAGES.reg)} AS reg,
          ${ppl(AIGUILD_STAGES.wd)}  AS wd,
          ${ppl(AIGUILD_STAGES.ig)}  AS ig,
          ${ppl(AIGUILD_STAGES.cc)}  AS cc
        FROM (VALUES (1::int,'近1日'),(7,'近7日'),(14,'近14日'),(30,'近30日')) pr(days,label)
        ORDER BY pr.days`,
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

// PWA渠道日报（结构同 AI公会日报：花费=账户集合 ÷ 非公会来源人数，按日）
const pwaDailyTable = (accounts) => ({
  key: "pwa_daily",
  name: "PWA渠道日报",
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
                WHERE account_id = ANY($3) AND date BETWEEN $1 AND $2 GROUP BY date),
      ppl AS (
        SELECT date,
          SUM(count) FILTER (WHERE stage_key=$4) reg,
          SUM(count) FILTER (WHERE stage_key=$5) wd,
          SUM(count) FILTER (WHERE stage_key=$6) ig,
          SUM(count) FILTER (WHERE stage_key=$7) cc
        FROM funnel_daily
        WHERE date BETWEEN $1 AND $2 AND stage_key IN ($4,$5,$6,$7) AND ${PWA_PPL_SOURCE}
        GROUP BY date)
      SELECT to_char(d.date,'YYYY-MM-DD') date, COALESCE(s.cost,0) cost,
             COALESCE(p.reg,0) reg, COALESCE(p.wd,0) wd, COALESCE(p.ig,0) ig, COALESCE(p.cc,0) cc
      FROM d LEFT JOIN spend s ON s.date=d.date LEFT JOIN ppl p ON p.date=d.date
      WHERE COALESCE(s.cost,0)>0 OR COALESCE(p.reg,0)>0 OR COALESCE(p.wd,0)>0
         OR COALESCE(p.ig,0)>0 OR COALESCE(p.cc,0)>0
      ORDER BY d.date DESC`,
    params: [from, to, accounts, AIGUILD_STAGES.reg, AIGUILD_STAGES.wd, AIGUILD_STAGES.ig, AIGUILD_STAGES.cc],
  }),
  toFields: (r) => {
    const cost = num(r.cost), reg = num(r.reg), wd = num(r.wd), ig = num(r.ig), cc = num(r.cc);
    const f = { 标识: r.date, 日期: dateMs(r.date), date_num: dateNum(r.date),
      花费: cost, 注册人数: reg, 首提人数: wd, IG授权人数: ig, 成材人数: cc };
    const rp = price(cost, reg), wp = price(cost, wd), ip = price(cost, ig), cp = price(cost, cc);
    if (rp !== undefined) f.注册单价 = rp;
    if (wp !== undefined) f.首提单价 = wp;
    if (ip !== undefined) f.IG授权单价 = ip;
    if (cp !== undefined) f.成材单价 = cp;
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
    const ppl = (stage) =>
      `(SELECT COALESCE(SUM(count),0) FROM funnel_daily
        WHERE date > $2::date - pr.days AND date <= $2::date AND stage_key='${stage}' AND ${PWA_PPL_SOURCE})`;
    return {
      text: `
        SELECT pr.label AS caliber, pr.days AS ord,
          (SELECT COALESCE(SUM(cost),0)::float8 FROM campaign_daily
           WHERE account_id = ANY($1) AND date > $2::date - pr.days AND date <= $2::date) AS cost,
          ${ppl(AIGUILD_STAGES.reg)} AS reg,
          ${ppl(AIGUILD_STAGES.wd)}  AS wd,
          ${ppl(AIGUILD_STAGES.ig)}  AS ig,
          ${ppl(AIGUILD_STAGES.cc)}  AS cc
        FROM (VALUES (1::int,'近1日'),(7,'近7日'),(14,'近14日'),(30,'近30日')) pr(days,label)
        ORDER BY pr.days`,
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

// ===== 留存（快照，来自 BytePlus sitin 看板的留存报表，经 fetch-retention.mjs 落 retention_summary 表；非 Postgres 事实）=====
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

// 从 ad_groups / 配置表解析派生看板的账户/系列集合。找不到配置时回退到写死的默认值，保证行为不变。
//   AI公会 = 名称含「AI公会/AIguild/公会」的分组 → 展开为 campaign_id 集合（花费按系列过滤）。
//   PWA(非公会)看板账户 = xmp_fetch_config 里 category='pwa_board' 的行（飞书「XMP抓取配置」表 类别=PWA看板账户）
//                        → 花费按账户过滤。与抓取范围(category='account')解耦：一个管进库、一个管看板汇总。
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

  // PWA(非公会)看板账户集（[{id,name}]）：读配置表 pwa_board 行，回退写死默认。
  // 配置里「值」可填账户 id 或名称 → 用 campaign_daily 双向解析出规范 {id, name}；未落库账户按填的值当 id 兜底。
  let pwaAccounts = PWA_ACCOUNTS.map((id, i) => ({ id, name: PWA_ACCOUNT_NAMES[i] || id }));
  try {
    const { rows: cfg } = await query(
      `SELECT value, name FROM xmp_fetch_config WHERE category = 'pwa_board' AND enabled = true`,
    );
    if (cfg.length) {
      const vals = cfg.map((r) => r.value);
      const { rows: acc } = await query(
        `SELECT DISTINCT account_id, account_name FROM campaign_daily
          WHERE account_id = ANY($1::text[]) OR account_name = ANY($1::text[])`,
        [vals],
      );
      const nameById = new Map(acc.map((a) => [a.account_id, a.account_name]));
      const idByName = new Map(acc.map((a) => [a.account_name, a.account_id]));
      const seen = new Set();
      const resolved = [];
      for (const r of cfg) {
        let id, nm;
        if (nameById.has(r.value)) { id = r.value; nm = nameById.get(r.value); }
        else if (idByName.has(r.value)) { id = idByName.get(r.value); nm = r.value; }
        else { id = r.value; nm = r.name || r.value; } // 未落库账户：按填的值当 id
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
    ...g.pwaAccounts.map((a) => pwaAccountTable(a.name, a.id)),
    pwaDailyTable(pwaAccIds),
    pwaSummaryTable(pwaAccIds),
    retentionUser,
    retentionChengcai,
  ];
}
