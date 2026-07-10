// 飞书镜像表的单一事实源：字段定义（建表用）+ Postgres 读取 SQL + 行→飞书字段映射（同步用）。
// feishu-init-tables.mjs 与 sync-to-feishu.mjs 都读这里，保证结构与写入一致、不漂移。
//
// 两类表：
//   windowed=true  按日期窗口镜像：靠 date_num(整数 YYYYMMDD) 做窗口删除+重灌（对齐 Postgres 的 DELETE+INSERT）。
//   windowed=false 配置类小表：全量替换（清空后重灌）。
import { FT, dateMs, dateNum } from "./lib/feishu.mjs";
import { FEISHU } from "./config.mjs";

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

// ---- AI公会日报（派生：广告分组「PWA AI公会」花费 ÷ AI公会来源人数，按日 join）----
// 花费 = 2 系列(0630_web_text 直发 + 0617_Customer Form_1 留咨)。
// 人数口径随日期切换（用户确认）：2026-07-03 前 source='AIguild' 为总口径；此后拆为 active+passive。
// 单价 = 花费 / 人数（人数为 0 则单价留空，区分「无」与「0」）。跨立方已在此 join 好，飞书仪表盘直接用。
const AIGUILD_CAMPAIGNS = ["120248092167100162", "120251189845320085"];
const AIGUILD_SPLIT_DATE = "2026-07-03";
const AIGUILD_STAGES = { reg: "cash_ready_show", wd: "withdraw_first", ig: "task_ins_bind", cc: "chengcai" };
const price = (cost, n) => (n > 0 ? Math.round((cost / n) * 100) / 100 : undefined);

const aiguildTable = {
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
    params: [from, to, AIGUILD_CAMPAIGNS,
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
};

// ---- AI公会汇总（3 行：近7日/近14日/近30日 各自的加权汇总，供指标卡取精确加权单价 = SUM花费/SUM人数）----
// 指标卡的 rollup 无法算 SUM/SUM 比值，故在此 SQL 里按周期算好；卡片按「口径」过滤到某周期后取 MAX(1 行) 即得精确值。
const aiguildSummaryTable = {
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
      params: [AIGUILD_CAMPAIGNS, to],
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
};

// ===== PWA 非公会渠道（花费=2 个 facebook 账户全部系列；人数=非公会来源 fb/tt/bff/unknown，即排除 AIguild 三桶，无日期切换）=====
const PWA_ACCOUNTS = ["864750783313841", "2236726820405499"]; // 省广_pwa_3_ymt_新, 省广_pwa_新_1_zmf
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
const pwaAcct1 = pwaAccountTable("省广_pwa_3_ymt_新", "864750783313841");
const pwaAcct2 = pwaAccountTable("省广_pwa_新_1_zmf", "2236726820405499");

// PWA渠道日报（结构同 AI公会日报：花费=2 账户 ÷ 非公会来源人数，按日）
const pwaDailyTable = {
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
    params: [from, to, PWA_ACCOUNTS, AIGUILD_STAGES.reg, AIGUILD_STAGES.wd, AIGUILD_STAGES.ig, AIGUILD_STAGES.cc],
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
};

// PWA渠道汇总（4 行：近1/7/14/30 日加权汇总，结构同 AI公会汇总）
const pwaSummaryTable = {
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
      params: [PWA_ACCOUNTS, to],
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
};

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

export const TABLES = [
  campaignTable,
  funnelTable,
  igTable,
  stageMetaTable,
  adGroupsTable,
  aiguildTable,
  aiguildSummaryTable,
  pwaAcct1,
  pwaAcct2,
  pwaDailyTable,
  pwaSummaryTable,
  retentionUser,
  retentionChengcai,
];
