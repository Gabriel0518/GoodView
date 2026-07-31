// 飞书镜像表的单一事实源：字段定义（建表用）+ Postgres 读取 SQL + 行→飞书字段映射（同步用）。
// feishu-init-tables.mjs 与 sync-to-feishu.mjs 都读这里，保证结构与写入一致、不漂移。
//
// 两类表：
//   windowed=true  按日期窗口镜像：靠 date_num(整数 YYYYMMDD) 做窗口删除+重灌（对齐 Postgres 的 DELETE+INSERT）。
//   windowed=false 配置类小表：全量替换（清空后重灌）。
import { FT, dateMs, dateNum } from "./lib/feishu.mjs";
import { FEISHU } from "./config.mjs";
import { loadAdGroups, resolveGroupToCampaignIds } from "./lib/groups.mjs";
import { REGION_LABEL } from "./lib/key-metrics.mjs";
import { query } from "./lib/db.mjs";

// 单选字段种子选项（新值写入时飞书会自动补建，这里只给已知值配色）
const seed = (names) => ({ options: names.map((name, i) => ({ name, color: i % 10 })) });
const CHANNELS = ["facebook", "tiktok", "google"];
const SOURCES = ["fb", "tt", "bff", "AIguild", "AIguild_active", "AIguild_passive", "google", "unknown"];

const num = (v) => (v == null ? 0 : Number(v));
const round2 = (v) => Math.round(num(v) * 100) / 100; // 花费类：截到分，避免飞书里一串浮点尾数
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

// ⚠️ SQL 里必须带白名单过滤（`acc` 子查询）。近 30 天窗口内 fetch-snapshot 已按白名单清过库，
// 看起来加不加都一样；但**回补历史时差别巨大**：30 天窗口之外的 campaign_daily 还留着白名单启用
// 之前的全量数据——5/03~7/01 就有 141 个别产品账户(ROMI/LUMA/KIRA…)的 17227 行、$231 万花费。
// 不过滤的话一回补就把这些噪音灌进飞书，既撑爆行数上限、又污染看板。
// 范围 = 账户白名单 ∪ 系列白名单（与 fetch-snapshot 的抓取范围同语义）：AI公会那个账户
// (省广_AI工会_web_1_wcx_0630) 只在系列白名单里，只按账户过滤会把它整个漏掉。
const campaignTable = {
  key: "campaign_daily",
  name: "广告投放日报",
  windowed: true,
  fields: campaignFields,
  sql: (from, to) =>
    adsetGrain
      ? {
          text: `WITH acc AS (SELECT value FROM xmp_fetch_config WHERE category='account' AND enabled),
                       camp AS (SELECT value FROM xmp_fetch_config WHERE category='campaign' AND enabled)
                  SELECT to_char(date,'YYYY-MM-DD') AS date, account_id, account_name, channel,
                         campaign_id, campaign_name, adset_id, adset_name,
                         cost::float8 AS cost, impression, click
                  FROM campaign_daily WHERE date BETWEEN $1 AND $2
                    AND (cost > 0 OR impression > 0 OR click > 0)
                    AND (account_id IN (SELECT value FROM acc) OR campaign_id IN (SELECT value FROM camp))
                  ORDER BY date DESC`,
          params: [from, to],
        }
      : {
          text: `WITH acc AS (SELECT value FROM xmp_fetch_config WHERE category='account' AND enabled),
                       camp AS (SELECT value FROM xmp_fetch_config WHERE category='campaign' AND enabled)
                  SELECT to_char(date,'YYYY-MM-DD') AS date, account_id, MAX(account_name) AS account_name, channel,
                         campaign_id, MAX(campaign_name) AS campaign_name,
                         SUM(cost)::float8 AS cost, SUM(impression)::bigint AS impression, SUM(click)::bigint AS click
                  FROM campaign_daily WHERE date BETWEEN $1 AND $2
                    AND (cost > 0 OR impression > 0 OR click > 0)
                    AND (account_id IN (SELECT value FROM acc) OR campaign_id IN (SELECT value FROM camp))
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
  F: { value: "值", category: "类别", name: "名称", layer: "落库层", enabled: "启用", status: "状态", group: "广告账户归属" },
  fields: [
    { field_name: "值", type: FT.TEXT }, // 主字段：账户ID/系列ID（或其名称）或 指标（曝光/impression）
    { field_name: "类别", type: FT.SINGLE_SELECT, property: seed(["广告账户", "广告系列", "指标"]) },
    { field_name: "名称", type: FT.TEXT }, // 可读备注（账户/系列名；指标可留空）
    // 归属决定这个账户的花费算进哪个看板：PWA / AI公会 / 上架包（SmartReply）。
    // 填「上架包」的账户 → 花费只进「上架包渠道日报」，并从 PWA 口径剔除（它们的转化走 AppsFlyer
    // 不走 BytePlus，留在 PWA 看板会变成「有花费零转化」，把 PWA 单价整体抬高）。留空按 PWA 处理。
    { field_name: "广告账户归属", type: FT.TEXT },
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
//
// 2026-07-30 起**改成配置驱动**：账户归属看飞书「XMP抓取配置」的「广告账户归属」列，填「上架包」
// （或 SmartReply/SR）即算上架包 → 加账户只在飞书加一行，不用改码。下面这份是**兜底默认**：
// 配置表里一个「上架包」归属都没有时（列没填/飞书读不到）才用，保证行为不回退。
const APP_ACCOUNTS = [
  { id: "6245583421",          name: "AI Fantasy-T8088",   channel: "google" },   // SR_android_wcx_install_0724_gg
  { id: "7665547836257058834", name: "省广_SR_and_1-5D80", channel: "tiktok" },   // Smart Reply-test
  { id: "27589868840681799",   name: "省广_SR_and_5_wcx",  channel: "facebook" }, // Smart Reply_android_wcx_install_0725
  { id: "1013644987935186",    name: "QQ-TZCH-3A-0721+8-01", channel: "facebook" }, // Smart Reply_android_0729（2026-07-29 开投）
];
// 归属列填什么算上架包（大小写不敏感、含即匹配）
const APP_GROUP_PATTERN = /上架包|smart\s*reply|smartreply|\bSR\b/i;

// 上架包渠道日报（date × 渠道，结构对齐 PWA渠道日报，便于两个产品横向对比）：
//   花费   = campaign_daily 上架包账户 按 channel（XMP）
//   安装数 = campaign_metric_daily 的 conversion（XMP 转化数，媒体侧回传口径）→ 安装单价 = 花费/转化数
//            为什么不用 AF 的 install 事件：AF Push 只能从开通那刻往后收、不补历史，且依赖 app 埋点；
//            XMP 的 conversion 是媒体自己回传的，有完整历史、与花费同源同日期口径，做单价更稳。
//            （MMP 口径的 mobile_app_install/active_register/af_conversion 对这些账户实测全为 0，用不了。）
//   2026-07-29 用户确认：app 侧打点尚不全 → 本表**只统计安装量**，注册列先撤。
//   （挂着恒为 0 的注册列会被误读成「没人注册」，而真实原因是打点没到，比没有这列更糟。）
//   af_events 仍在持续收全部 AF 事件、一条不丢；打点补全后把 af_event_map 里的
//   af_login_success 置回 enabled、加回两列即可，历史数据不会缺。
const appDailyTable = (accountIds) => ({
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
  ],
  sql: (from, to) => ({
    text: `
      WITH d AS (SELECT generate_series($1::date,$2::date,'1 day')::date date),
      ch(label,channel,so) AS (VALUES ('Facebook','facebook',0),('TikTok','tiktok',1),('Google','google',2),('自然量','',3),('其他','',4)),
      spend AS (SELECT date, channel, SUM(cost)::float8 cost FROM campaign_daily
                WHERE account_id = ANY($3) AND date BETWEEN $1 AND $2 GROUP BY date, channel),
      -- 安装数 = XMP 转化数。conversion 落在扩展指标长表，按 (date,account,campaign,adset) 与 campaign_daily
      -- 对齐；长表本身不存 channel，故 join 回宽表取渠道。
      inst AS (SELECT c.date, c.channel, SUM(mm.value)::float8 conv
               FROM campaign_metric_daily mm
               JOIN campaign_daily c
                 ON c.date = mm.date AND c.account_id = mm.account_id
                AND c.campaign_id = mm.campaign_id AND c.adset_id = mm.adset_id
               WHERE mm.metric_key = 'conversion' AND mm.account_id = ANY($3)
                 AND mm.date BETWEEN $1 AND $2
               GROUP BY c.date, c.channel)
      SELECT to_char(d.date,'YYYY-MM-DD') date, ch.label channel, ch.so so, COALESCE(s.cost,0) cost,
             COALESCE(i.conv,0) installs
      FROM d CROSS JOIN ch
      LEFT JOIN spend s ON s.date=d.date AND s.channel=ch.channel
      LEFT JOIN inst  i ON i.date=d.date AND i.channel=ch.channel
      WHERE COALESCE(s.cost,0)>0 OR COALESCE(i.conv,0)>0
      ORDER BY d.date DESC, ch.so`,
    params: [from, to, accountIds],
  }),
  toFields: (r) => {
    const cost = num(r.cost), inst = num(r.installs);
    const f = { 标识: `${r.date}|${r.channel}`, 日期: dateMs(r.date), date_num: dateNum(r.date),
      渠道: r.channel, 渠道名称: r.channel, 花费: cost, 安装数: inst };
    // 单价仅在有花费时给出；自然量行无花费(0) → 留空，避免 $0 误导（与 PWA 表同款处理）。
    if (cost > 0) {
      const ip = price(cost, inst);
      if (ip !== undefined) f.安装单价 = ip;
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

// ===== 关键指标日报（德州 / 非德州 / 全量）=====
// 数据来自 key_metric_daily（fetch-key-metrics.mjs），口径 = BytePlus「PWA 德州关键指标转化率看板」
// 官方配置，逐字定义在 lib/key-metrics.mjs。一行 = 一天 × 一个地区，6 个指标横排 → 飞书里直接做
// 双轴/对比图（地区做系列）。
// ⚠️ 「成材用户」是 PV(总次数)，其余 5 个是 UV(去重人数)——官方看板就这么配的，别当人数解读。
// ⚠️ 三个地区各自独立查询：德州+非德州 会略大于 全量（跨州用户两边各算一次，实测 +0.4%），
//    所以别用 全量−德州 当非德州，直接取「非德州」行。
// 转化率分母的选择：官方链路是 曝光→安装→注册→(可分发/IG/成材)，但注册人数 > 安装成功人数
//    （很多人不装 PWA 直接在浏览器里注册），若按 注册/安装 会 >100% 误导 → 前两级都以曝光为分母，
//    后三级以注册为分母。
// 「广告消耗」列（XMP，按地区填）：
//    全量   = PWA 口径账户花费 **剔除 AI公会系列**（公会有独立看板，花费另算）。2026-07-30 与用户
//             参考数核对：7/28 剔公会后 $1930.72 vs 用户 $1930.62（差 $0.10 是 XMP 账户时区混用
//             上海/香港的边界零头）；不剔公会是 $1977.64，差的正是公会系列 $46.92。
//    德州   = 定向德州的系列花费（系列名 ~* TX_CAMPAIGN_PATTERN；XMP 无州级维度，只能按系列切）
//    非德州 = 全量 − 德州系列
// ⚠️ 花费按**系列定向**切，转化按**用户属性省份**切，两者不是同一批人：全美投放的系列同样会带来
//    德州用户 → 「德州」行的消耗偏小、「非德州」行偏大。做德州单价要知道这是低估；要粗估德州真实
//    成本，用 全量消耗 × 德州注册占比（见「德州近30日统计」表）。
// ⚠️ 转化锚 America/Chicago（德州本地，对齐官方看板），花费锚 XMP 账户时区（上海/香港），两者差约
//    13 小时 → 单价是近似值。见 lib/key-metrics.mjs KEY_METRIC_TIMEZONE。
//
// 【注册 / IG绑定 / 成材 改用业务库(DMS)，2026-07-31 用户拍板】：这三个在自有后台是**真实业务记录**
//   （建号行 / 任务完成行 / 提现申请行），比前端埋点准，也不会像 BytePlus 那样因用户属性回溯变动而漂移。
//   注册尤其重要：口径定义仍是「0.5刀提现弹窗曝光」，但那个事件**会对同一人跨天重复触发**
//   （30 天去重 5598 人 vs 逐日求和 10603 人次，1.9 倍）→ BytePlus 日 UV 是「当日看到弹窗的人数」
//   而非「当日新注册」；业务库建号行天然每人一次，才是日新增。
//   但业务库**切不了德州**（geo 列脏、zip 只有 16% 覆盖）→ 只有【全量】行用 DMS，
//   德州/非德州行仍是 BytePlus。「核心指标来源」列标明每行用的是哪个源，别看串。
//   ⚠️ 副作用：全量行换源后，德州+非德州 ≠ 全量（换源差 + 本来就有的跨州重算差），而且**地区行的
//   注册仍是含回访的日 UV、量级比全量行大**。要同源比较就只看德州/非德州两行，别拿它们和全量行做减法。
const keyMetricTable = (guildCampaigns) => ({
  key: "key_metric_daily",
  name: "关键指标日报",
  windowed: true,
  fields: [
    { field_name: "标识", type: FT.TEXT },
    { field_name: "日期", type: FT.DATE },
    { field_name: "date_num", type: FT.NUMBER },
    { field_name: "地区", type: FT.SINGLE_SELECT, property: { options: [{ name: "德州", color: 1 }, { name: "非德州", color: 3 }, { name: "全量", color: 5 }] } },
    { field_name: "地区名称", type: FT.TEXT },
    { field_name: "广告消耗", type: FT.NUMBER },
    { field_name: "投广页曝光", type: FT.NUMBER },
    { field_name: "安装成功", type: FT.NUMBER },
    { field_name: "用户注册", type: FT.NUMBER },
    { field_name: "可分发用户", type: FT.NUMBER },
    { field_name: "IG绑定用户", type: FT.NUMBER },
    { field_name: "成材用户(次数)", type: FT.NUMBER },
    { field_name: "安装率%(安装/曝光)", type: FT.NUMBER },
    { field_name: "注册率%(注册/曝光)", type: FT.NUMBER },
    { field_name: "可分发率%(可分发/注册)", type: FT.NUMBER },
    { field_name: "IG绑定率%(IG/注册)", type: FT.NUMBER },
    { field_name: "成材率%(成材/注册)", type: FT.NUMBER },
    { field_name: "注册单价", type: FT.NUMBER },
    { field_name: "核心指标来源", type: FT.SINGLE_SELECT, property: { options: [{ name: "业务库·日新增", color: 2 }, { name: "BytePlus·含回访", color: 4 }] } },
  ],
  sql: (from, to) => ({
    text: `
      WITH km AS (
        SELECT date, region,
               COALESCE(SUM(count) FILTER (WHERE metric_key = 'lp_show'), 0)::bigint         AS lp_show,
               COALESCE(SUM(count) FILTER (WHERE metric_key = 'install_success'), 0)::bigint AS install_success,
               COALESCE(SUM(count) FILTER (WHERE metric_key = 'register'), 0)::bigint        AS register,
               COALESCE(SUM(count) FILTER (WHERE metric_key = 'distributable'), 0)::bigint   AS distributable,
               COALESCE(SUM(count) FILTER (WHERE metric_key = 'ig_bind'), 0)::bigint         AS ig_bind,
               COALESCE(SUM(count) FILTER (WHERE metric_key = 'chengcai'), 0)::bigint        AS chengcai
          FROM key_metric_daily
         WHERE date BETWEEN $1 AND $2
         GROUP BY date, region
        HAVING SUM(count) > 0
      ),
      -- PWA 口径账户 = 抓取配置里非「上架包」归属的账户（上架包转化走 AF，花费不能混进来）
      acc AS (
        SELECT value FROM xmp_fetch_config
         WHERE category='account' AND enabled AND (group_name IS NULL OR group_name !~* '上架包|smart ?reply')
      ),
      sp AS (
        SELECT date,
               COALESCE(SUM(cost), 0)                                        AS all_cost,
               COALESCE(SUM(cost) FILTER (WHERE campaign_name ~* $3), 0)      AS tx_cost
          FROM campaign_daily
         WHERE date BETWEEN $1 AND $2 AND account_id IN (SELECT value FROM acc)
           AND campaign_id <> ALL($4::text[])   -- 剔除 AI公会系列（花费归公会看板）
         GROUP BY date
      )
      SELECT to_char(km.date,'YYYY-MM-DD') AS date, km.region,
             km.lp_show, km.install_success, km.distributable,
             -- 全量行优先用业务库(DMS)的真实记录；DMS 缺数则回退 BytePlus。地区行只能用 BytePlus。
             (CASE WHEN km.region = 'all' THEN COALESCE(d_rg.count, km.register)  ELSE km.register END) AS register,
             (CASE WHEN km.region = 'all' THEN COALESCE(d_ig.count, km.ig_bind)   ELSE km.ig_bind  END) AS ig_bind,
             (CASE WHEN km.region = 'all' THEN COALESCE(d_cc.count, km.chengcai)  ELSE km.chengcai END) AS chengcai,
             (km.region = 'all' AND d_rg.count IS NOT NULL) AS from_dms,
             (CASE km.region
                WHEN 'TX'    THEN COALESCE(sp.tx_cost, 0)
                WHEN 'nonTX' THEN COALESCE(sp.all_cost, 0) - COALESCE(sp.tx_cost, 0)
                ELSE              COALESCE(sp.all_cost, 0)
              END)::float8 AS cost
        FROM km
        LEFT JOIN sp ON sp.date = km.date
        LEFT JOIN dms_metric_daily d_rg ON d_rg.date = km.date AND d_rg.metric_key = 'register'
        LEFT JOIN dms_metric_daily d_ig ON d_ig.date = km.date AND d_ig.metric_key = 'ig_bind'
        LEFT JOIN dms_metric_daily d_cc ON d_cc.date = km.date AND d_cc.metric_key = 'chengcai'
       ORDER BY km.date DESC, km.region`,
    params: [from, to, TX_CAMPAIGN_PATTERN, guildCampaigns],
  }),
  toFields: (r) => {
    const label = REGION_LABEL[r.region] || r.region;
    const lp = num(r.lp_show), inst = num(r.install_success), reg = num(r.register);
    const dist = num(r.distributable), ig = num(r.ig_bind), cc = num(r.chengcai);
    const cost = round2(r.cost);
    const f = {
      标识: `${r.date}|${r.region}`,
      日期: dateMs(r.date), date_num: dateNum(r.date),
      地区: label, 地区名称: label,
      广告消耗: cost,
      投广页曝光: lp, 安装成功: inst, 用户注册: reg,
      可分发用户: dist, IG绑定用户: ig, "成材用户(次数)": cc,
      // 标签必须写清尺度：全量行是「日新增」(每人一次)，地区行是「含回访」(当日看到弹窗的人数，
      // 约 1.9 倍)。两者不同量级，看板上会出现 非德州 > 全量 —— 不是数据错，是尺度不同。
      "核心指标来源": r.from_dms ? "业务库·日新增" : "BytePlus·含回访",
    };
    // 分母为 0 的率留空（不写 0），避免"0%"被读成真的没转化
    const rate = (a, b) => (b > 0 ? Math.round((a / b) * 10000) / 100 : undefined);
    const add = (k, v) => { if (v !== undefined) f[k] = v; };
    add("安装率%(安装/曝光)", rate(inst, lp));
    add("注册率%(注册/曝光)", rate(reg, lp));
    add("可分发率%(可分发/注册)", rate(dist, reg));
    add("IG绑定率%(IG/注册)", rate(ig, reg));
    add("成材率%(成材/注册)", rate(cc, reg));
    if (cost > 0) add("注册单价", price(cost, reg)); // 无花费的日子留空，别显示 $0
    return f;
  },
});

// ===== 德州近30日统计（德州转化 + 分渠道消耗，一天一行，给飞书仪表盘直接用）=====
//
// 【转化】来自 key_metric_daily 的 region='TX'（BytePlus 官方关键指标口径，按用户属性
//   loc_province_id=4736286 精确切德州；成材是 PV 次数，其余是 UV 人数）。
//
// 【消耗】XMP **没有州级维度**（geo 维度只到国家，PWA 账户全是 US），所以德州花费只能取
//   **定向德州的广告系列**：系列名含 texas/德州/德克萨斯。近30天 11 条系列全用 "texas" 命名，
//   无其它变体；2026-07-21 才开投。分渠道用 campaign_daily.channel（XMP module）。
//
// ⚠️ 两个口径**不是同一批人**，看单价时必须知道：
//   · 德州转化 = 所有德州用户，含全美投放系列带来的（7/21 之前德州系列还没开，转化却一直有）。
//   · 德州系列花费 = 只有定向德州的那几条系列。
//   → 「德州系列注册单价」是**低估**（分母含非德州系列带来的德州用户）。要粗估德州总成本，
//     用 PWA全部花费 × 德州注册占比（表里都给了，仪表盘里自己乘）。
//   · 单价仅在当天德州系列有花费时给出，否则留空（7/21 前全部留空，不是 0）。
const TX_CAMPAIGN_PATTERN = "texas|德州|德克萨斯";
const txDailyTable = (guildCampaigns) => ({
  key: "tx_daily",
  name: "德州近30日统计",
  windowed: true,
  fields: [
    { field_name: "标识", type: FT.TEXT },
    { field_name: "日期", type: FT.DATE },
    { field_name: "date_num", type: FT.NUMBER },
    // —— 德州转化（BytePlus，精确到州）——
    { field_name: "投广页曝光", type: FT.NUMBER },
    { field_name: "安装成功", type: FT.NUMBER },
    { field_name: "用户注册", type: FT.NUMBER },
    { field_name: "可分发用户", type: FT.NUMBER },
    { field_name: "IG绑定用户", type: FT.NUMBER },
    { field_name: "成材用户(次数)", type: FT.NUMBER },
    // —— 德州定向系列花费，分渠道（XMP）——
    { field_name: "Facebook花费", type: FT.NUMBER },
    { field_name: "TikTok花费", type: FT.NUMBER },
    { field_name: "Google花费", type: FT.NUMBER },
    { field_name: "德州系列花费", type: FT.NUMBER },
    // —— 参考口径 ——
    { field_name: "PWA全部花费", type: FT.NUMBER },
    { field_name: "德州注册占比%", type: FT.NUMBER },
    { field_name: "德州系列注册单价", type: FT.NUMBER },
    { field_name: "德州系列成材单价", type: FT.NUMBER },
  ],
  sql: (from, to) => ({
    text: `
      WITH d AS (SELECT generate_series($1::date, $2::date, '1 day')::date AS date),
      km AS (
        SELECT date,
               SUM(count) FILTER (WHERE metric_key='lp_show'         AND region='TX')  AS lp,
               SUM(count) FILTER (WHERE metric_key='install_success' AND region='TX')  AS inst,
               SUM(count) FILTER (WHERE metric_key='register'        AND region='TX')  AS reg,
               SUM(count) FILTER (WHERE metric_key='distributable'   AND region='TX')  AS dist,
               SUM(count) FILTER (WHERE metric_key='ig_bind'         AND region='TX')  AS ig,
               SUM(count) FILTER (WHERE metric_key='chengcai'        AND region='TX')  AS cc,
               SUM(count) FILTER (WHERE metric_key='register'        AND region='all') AS reg_all
          FROM key_metric_daily WHERE date BETWEEN $1 AND $2 GROUP BY date
      ),
      -- PWA 口径账户 = 抓取配置里非「上架包」归属的账户（上架包转化走 AF，不掺进来）
      acc AS (
        SELECT value FROM xmp_fetch_config
         WHERE category='account' AND enabled AND (group_name IS NULL OR group_name !~* '上架包|smart ?reply')
      ),
      sp AS (
        SELECT date,
               SUM(cost) FILTER (WHERE campaign_name ~* $3 AND channel='facebook') AS tx_fb,
               SUM(cost) FILTER (WHERE campaign_name ~* $3 AND channel='tiktok')   AS tx_tt,
               SUM(cost) FILTER (WHERE campaign_name ~* $3 AND channel='google')   AS tx_gg,
               SUM(cost) FILTER (WHERE campaign_name ~* $3)                        AS tx_all,
               SUM(cost)                                                           AS pwa_all
          FROM campaign_daily
         WHERE date BETWEEN $1 AND $2 AND account_id IN (SELECT value FROM acc)
           AND campaign_id <> ALL($4::text[])   -- 剔除 AI公会系列（花费归公会看板）
         GROUP BY date
      )
      SELECT to_char(d.date,'YYYY-MM-DD') AS date,
             COALESCE(km.lp,0)::bigint lp, COALESCE(km.inst,0)::bigint inst, COALESCE(km.reg,0)::bigint reg,
             COALESCE(km.dist,0)::bigint dist, COALESCE(km.ig,0)::bigint ig, COALESCE(km.cc,0)::bigint cc,
             COALESCE(km.reg_all,0)::bigint reg_all,
             COALESCE(sp.tx_fb,0)::float8 tx_fb, COALESCE(sp.tx_tt,0)::float8 tx_tt,
             COALESCE(sp.tx_gg,0)::float8 tx_gg, COALESCE(sp.tx_all,0)::float8 tx_all,
             COALESCE(sp.pwa_all,0)::float8 pwa_all
        FROM d LEFT JOIN km ON km.date = d.date LEFT JOIN sp ON sp.date = d.date
       ORDER BY d.date DESC`,
    params: [from, to, TX_CAMPAIGN_PATTERN, guildCampaigns],
  }),
  toFields: (r) => {
    const reg = num(r.reg), cc = num(r.cc), txAll = num(r.tx_all), regAll = num(r.reg_all);
    const f = {
      标识: r.date,
      日期: dateMs(r.date), date_num: dateNum(r.date),
      投广页曝光: num(r.lp), 安装成功: num(r.inst), 用户注册: reg,
      可分发用户: num(r.dist), IG绑定用户: num(r.ig), "成材用户(次数)": cc,
      Facebook花费: round2(r.tx_fb), TikTok花费: round2(r.tx_tt), Google花费: round2(r.tx_gg),
      德州系列花费: round2(txAll), PWA全部花费: round2(r.pwa_all),
    };
    const add = (k, v) => { if (v !== undefined) f[k] = v; };
    add("德州注册占比%", regAll > 0 ? Math.round((reg / regAll) * 10000) / 100 : undefined);
    // 单价仅在德州系列当天真有花费时给（否则留空，别让 7/21 前的空窗显示成 $0）
    if (txAll > 0) {
      add("德州系列注册单价", price(txAll, reg));
      add("德州系列成材单价", price(txAll, cc));
    }
    return f;
  },
});

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

  // PWA(非公会)看板账户集（[{id,name}]）：抓取配置的 account 行 − 公会账户 − 上架包账户 − 无花费账户，
  // 回退写死默认。上架包账户集同样从配置的「广告账户归属」列解析（回退 APP_ACCOUNTS）。
  let pwaAccounts = PWA_ACCOUNTS.map((id, i) => ({ id, name: PWA_ACCOUNT_NAMES[i] || id }));
  let appAccounts = APP_ACCOUNTS.map((a) => ({ id: a.id, name: a.name }));
  try {
    const { rows: accRows } = await query(
      `SELECT value, name, group_name FROM xmp_fetch_config WHERE category = 'account' AND enabled = true`,
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
      // 值(id 或名称) → 规范 {id, name}；查无此账户返回 null
      const canon = (v) => (nameById.has(v) ? { id: v, name: nameById.get(v) }
        : idByName.has(v) ? { id: idByName.get(v), name: v } : null);

      // 上架包(SmartReply)账户 = 归属列填「上架包/SmartReply/SR」的账户行。
      // 配置里一个都没标 → 保留写死的 APP_ACCOUNTS 兜底（防归属列没填就把上架包花费混回 PWA）。
      const fromCfg = [];
      for (const r of accRows) {
        if (!APP_GROUP_PATTERN.test(r.group_name || "")) continue;
        const c = canon(r.value);
        if (c && !fromCfg.some((x) => x.id === c.id)) fromCfg.push({ id: c.id, name: r.name || c.name });
      }
      if (fromCfg.length) appAccounts = fromCfg;

      const seen = new Set();
      const resolved = [];
      for (const r of accRows) {
        let id, nm;
        if (nameById.has(r.value)) { id = r.value; nm = nameById.get(r.value); }
        else if (idByName.has(r.value)) { id = idByName.get(r.value); nm = r.value; }
        else continue;                        // 填的值在库里查无此账户 → 跳过（无数据可展示）
        if (guildAccIds.has(id)) continue;     // 排除公会账户（花费归公会看板）
        if (appAccounts.some((a) => a.id === id)) continue; // 排除上架包账户（花费归「上架包渠道日报」；
                                               // 它们的转化在 AF 不在 BytePlus，留在这儿会永远是「有花费零转化」）
        if (!spendById.has(id)) continue;     // 排除近 60 天零花费账户（免建空的账户系列表）
        if (seen.has(id)) continue;
        seen.add(id);
        resolved.push({ id, name: r.name || nm || id });
      }
      if (resolved.length) pwaAccounts = resolved;
    }
  } catch { /* 读配置失败 → 保留默认 */ }

  return { aiguildCampaigns, pwaAccounts, appAccounts };
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
    appDailyTable(g.appAccounts.map((a) => a.id)),
    txDailyTable(g.aiguildCampaigns),
    keyMetricTable(g.aiguildCampaigns),
    retentionUser,
    retentionChengcai,
  ];
}
