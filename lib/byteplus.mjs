// BytePlus DataRangers (Data Intelligence) 取数模块
import crypto from "node:crypto";
import { BYTEPLUS } from "../config.mjs";
import { fetchRetry, isTransient } from "./http.mjs";

const URI = "/datafinder/openapi/v1/analysis";
const hmacHex = (key, msg) =>
  crypto.createHmac("sha256", key).update(msg, "utf8").digest("hex");

// 两段式 HMAC-SHA256 签名，最终串放进 Authorization 头
function authHeader(method, uri, queryString, body) {
  const ts = Math.floor(Date.now() / 1000);
  const exp = ts + 300;
  const prefix = `ak-v1/${BYTEPLUS.ak}/${ts}/${exp}`;
  const signKey = hmacHex(BYTEPLUS.sk, prefix);
  const canonical =
    `HTTPMethod:${method}\n` +
    `CanonicalURI:${uri}\n` +
    `CanonicalQueryString:${queryString}\n` +
    `CanonicalBody:${body}`;
  return `${prefix}/${hmacHex(signKey, canonical)}`;
}

const fmtDate = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 官方强制过滤：排除测试用户（is_test 用户属性 + isTest 事件属性，两条都要排；见 数据口径-BytePlus计算方法.md §4.3）。
// 取值与 BytePlus 看板「细分筛选」逐字对齐（关键指标看板 report 7668160292471177733 的 profile_filters）：
//   is_test(profile)  != ["true", ""]     ← 官方多带一个空字符串
//   isTest(event_param) != ["true"]
// 实测（tx-probe，7天注册）两种写法结果一致（2061 = 2061），带上空串只是与官方逐字一致、不改数。
const cond = (property_type, property_name, property_operation, property_values) => ({
  logic: "or",
  conditions: [{ property_type, property_name, property_compose_type: "origin", property_operation, property_values }],
});
const IS_TEST_EXPRS = [
  cond("profile", "is_test", "!=", ["true", ""]),
  cond("event_param", "isTest", "!=", ["true"]),
];

// 地区细分（BytePlus 用户属性 loc_province_id；德州 = 4736286，见「PWA德州实验看板」全部报表）。
// 注意：按 loc_province_id 分组返回的是 URL 编码的中文省名（%E5%BE%B7...=德克萨斯州），过滤仍用数字 id。
export const TEXAS_PROVINCE_ID = "4736286";
export const REGION_EXPRS = {
  all: [],                                                              // 不加省份条件 = 全量
  TX: [cond("profile", "loc_province_id", "=", [TEXAS_PROVINCE_ID])],    // 德州
  nonTX: [cond("profile", "loc_province_id", "!=", [TEXAS_PROVINCE_ID])],// 非德州（"!=" 含未知省份）
};

// 事件属性过滤 → 官方格式（expression/logic/conditions + property_values；扁平写法会被静默忽略）。
// filters = [{property, values, operation?, property_type?}]。
//
// ⚠️⚠️ 默认 logic = **"or"**：多条 filters 之间是**或**关系，不是且！
//   这是历史约定，为的是表达"成材 = withdraw_amount=25 OR will_cashout_stage=CashoutStageFive"
//   （数据口径 §4.4）。要"且"必须显式传 logic="and"。
//   2026-08-19 踩过：Savvy 小美口径想要 `pwa_app_name=savvy AND face_score>=70`，
//   用默认值写出来变成 OR，小美注册 111 > 真值 42、小美IG绑定 37 甚至超过了 IG绑定总数 34。
export function buildEventFilter(filters, logic = "or") {
  if (!filters || !filters.length) return [];
  const conditions = filters.map((f) => ({
    property_type: f.property_type || "event_param",
    property_name: f.property,
    property_compose_type: "origin",
    property_operation: f.operation || "=",
    property_values: f.values,
  }));
  return [{ expression: { logic: "and", expressions: [{ logic, conditions }] } }];
}

// 发送 DSL，返回完整 json（不因 code!=200 抛错）。探针/自定义查询用。
export async function postAnalysis(dsl) {
  const body = JSON.stringify(dsl);
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetchRetry(BYTEPLUS.host + URI, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader("POST", URI, "", body) },
        body,
      });
      return await res.json();
    } catch (e) {
      if (isTransient(e) && attempt < 6) {
        const wait = 1000 + attempt * 1500;
        console.warn(`  ⚠️ BytePlus 网络抖动(${e?.cause?.code || e?.message})，${Math.round(wait / 1000)}s 后重试…`);
        await sleep(wait);
        continue;
      }
      throw e;
    }
  }
}

// 通用：向任意 openapi 路径 POST，返回完整 json。取报表数据等用。
export async function postPath(uri, bodyObj = {}) {
  const body = JSON.stringify(bodyObj);
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetchRetry(BYTEPLUS.host + uri, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader("POST", uri, "", body) },
        body,
      });
      return await res.json();
    } catch (e) {
      if (isTransient(e) && attempt < 6) {
        const wait = 1000 + attempt * 1500;
        console.warn(`  ⚠️ BytePlus 网络抖动(${e?.cause?.code || e?.message})，${Math.round(wait / 1000)}s 后重试…`);
        await sleep(wait);
        continue;
      }
      throw e;
    }
  }
}

// 取某报表数据：POST /datafinder/openapi/v1/{app_id}/reports/{report_id}（空 body），返回含 dsls[].dsl_content 的完整 json。
export async function getReport(reportId) {
  return postPath(`/datafinder/openapi/v1/${BYTEPLUS.appId}/reports/${reportId}`, {});
}

async function runAnalysis(dsl) {
  const json = await postAnalysis(dsl);
  if (json.code !== 200) {
    throw new Error(`BytePlus code=${json.code} ${json.message || JSON.stringify(json)}`);
  }
  return json.data?.[0];
}

function eventQuery({ eventName, indicator, filters = [] }) {
  return {
    event_name: eventName,
    event_type: "origin",
    show_name: eventName,
    groups_v2: [],
    filters,
    show_label: "A",
    event_indicator: indicator,
    measure_info: {},
    indicator_show_name: "",
  };
}

// tz 相对 UTC 的偏移（分钟，东为正）。用 Intl 反推，DST 安全。
function tzOffsetMin(tz, date) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(date).reduce((a, x) => ((a[x.type] = x.value), a), {});
  const hour = p.hour === "24" ? 0 : Number(p.hour); // Intl 午夜给 "24"，不归零会整整差一天
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, hour, p.minute, p.second);
  return Math.round((asUTC - date.getTime()) / 60000);
}

// 最近 N 天「含今天」的 period（past_range 覆盖 目标tz 当天00:00 ~ 此刻）。
// 关键：BytePlus 的 type:"last" 只返回已结束的完整日、**不含当天进行中的一天** → 当天注册拿不到。
// 5 分钟回传下当天数据其实可取，故改用 past_range 覆盖到 now，拿到当天实时注册（当天为进行中值）。
function lastDaysIncludingToday(lastDays, tz) {
  const now = new Date();
  const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now); // YYYY-MM-DD in tz
  const startD = new Date(todayStr + "T00:00:00Z");
  startD.setUTCDate(startD.getUTCDate() - (lastDays - 1));
  const startYmd = startD.toISOString().slice(0, 10);
  const off = tzOffsetMin(tz, now);
  const startSec = Math.floor((Date.parse(startYmd + "T00:00:00Z") - off * 60000) / 1000); // 目标tz startYmd 00:00
  const endSec = Math.floor(now.getTime() / 1000);
  return { granularity: "day", type: "past_range", timezone: tz, spans: [{ type: "timestamp", timestamp: String(startSec) }, { type: "timestamp", timestamp: String(endSec) }] };
}

function baseDsl({ lastDays, period, profileExpressions = [], timezone }) {
  return {
    use_app_cloud_id: true,
    app_ids: [BYTEPLUS.appId],
    version: 3,
    // 默认按天取最近 N 天（含今天）；传 period 则用自定义时间段（如固定起止 + 整段去重）
    periods: [
      period || lastDaysIncludingToday(lastDays, timezone || BYTEPLUS.timezone),
    ],
    content: {
      profile_groups_v2: [],
      // 官方口径：始终排除测试用户；profileExpressions 追加用户属性细分（如德州/非德州）。
      profile_filters: [{ expression: { logic: "and", expressions: [...IS_TEST_EXPRS, ...profileExpressions] } }],
      orders: [],
      query_type: "event",
      queries: [[]],
      page: { limit: 1000, offset: 0 }, // 分组数量上限，默认 50 会截断小分组(如 AIguild)
      option: { refresh_cache: false, fusion: false },
    },
  };
}

// 单序列（不分组）：返回 [{ date, count }]。filters=事件属性过滤定义（[{property,values}]）；
// profileExpressions=额外用户属性细分（如 REGION_EXPRS.TX）；timezone 覆盖项目默认时区。
export async function fetchEventDaily({ eventName, lastDays, indicator = "event_users", filters = null, profileExpressions = [], timezone, period = null }) {
  const dsl = baseDsl({ lastDays, period, profileExpressions, timezone });
  dsl.content.queries = [[eventQuery({ eventName, indicator, filters: buildEventFilter(filters) })]];
  const q = await runAnalysis(dsl);
  const dates = q?.date_index_list || [];
  const vals = q?.data_item_list?.[0]?.data || [];
  return dates.map((d, i) => ({ date: fmtDate(d), count: Number(vals[i]) || 0 }));
}

// 按属性分组（默认用户属性 profile source）+ 可选事件属性过滤（官方格式，跨属性 OR 支持）。
// groupBy 分组字段；propertyType 分组属性类型；filters=事件属性过滤定义（[{property,values}]，多条=OR）。
// 返回 { dates:[...], series:[{ group, data:[], sum }] }
export async function fetchEventDailyGrouped({
  eventName, lastDays, groupBy,
  propertyType = "profile", groupLocation = "content", indicator = "event_users",
  filters = null, rawFilters = null, groups = null, period = null,
  profileExpressions = [], timezone,
}) {
  const dsl = baseDsl({ lastDays, period, profileExpressions, timezone });
  // rawFilters（探针脚本用）直接透传；否则由 filters 定义构建官方格式。
  const q = eventQuery({ eventName, indicator, filters: rawFilters || buildEventFilter(filters) });

  // groups 支持多维分组；不传则用单个 groupBy
  const groupList = groups || [{ property_name: groupBy, property_type: propertyType, location: groupLocation }];
  for (const g of groupList) {
    const obj = { property_type: g.property_type, property_name: g.property_name };
    if ((g.location || "content") === "content") dsl.content.profile_groups_v2.push(obj);
    else q.groups_v2.push(obj);
  }
  dsl.content.queries = [[q]];

  const r = await runAnalysis(dsl);
  const dates = (r?.date_index_list || []).map(fmtDate);
  const series = (r?.data_item_list || []).map((it) => ({
    group: it.group_by_key,
    data: (it.data || []).map((n) => Number(n) || 0),
    sum: Number(it.sum) || 0,
  }));
  return { dates, series };
}

// ───────────── 固定日期段 / 用户属性区间 / 漏斗（Savvy 新口径用）─────────────

// 目标时区 ymd 当天 00:00 的 UTC 毫秒。两遍求偏移是为了 DST 切换日也准
// （第一遍用当天 00:00Z 的偏移落一个近似点，第二遍再用那个点上的真实偏移定稿）。
export function dayStartMs(ymd, tz) {
  const naive = Date.parse(`${ymd}T00:00:00Z`);
  const once = naive - tzOffsetMin(tz, new Date(naive)) * 60000;
  return naive - tzOffsetMin(tz, new Date(once)) * 60000;
}

// [fromYmd 00:00, toYmd 23:59:59] 的固定日期段（目标时区）。
// 与 lastDaysIncludingToday 的区别：这里是**绝对起止**，不含「今天进行中」的语义，
// 调用方自己保证 toYmd 是已经结束的日子。
export function dayRangePeriod(fromYmd, toYmd, tz) {
  const start = Math.floor(dayStartMs(fromYmd, tz) / 1000);
  const end = Math.floor(dayStartMs(toYmd, tz) / 1000) + 86399;
  return { granularity: "day", type: "past_range", timezone: tz,
    spans: [{ type: "timestamp", timestamp: String(start) }, { type: "timestamp", timestamp: String(end) }] };
}

// 用户属性的数值半开区间 [lo, hi) → 两个 profile 条件（AND 关系，塞进 profileExpressions）。
// ⚠️ 实测 BytePlus 不认 "range"/"between" 之外的数组写法，但 ">=" + "<" 两条分开写是可靠的
//    （2026-08-19 探针：user_register_time 全量 133 → 当天注册 113 → 早于当天 12，能对上）。
// ⚠️ 比较是**数值**比较不是字符串（探针：face_score >= "9" 得 109 而非只匹配 9 开头的），
//    所以毫秒时间戳直接传字符串也安全。
export function profileRangeExprs(name, lo, hi) {
  return [
    cond("profile", name, ">=", [String(lo)]),
    cond("profile", name, "<", [String(hi)]),
  ];
}

// 漏斗的一步。event_id 必填（缺了会被判非法），filters 走 buildEventFilter 的官方格式。
export function funnelStep(showLabel, eventName, filters = null, filterLogic = "or") {
  return {
    event_name: eventName, event_type: "origin", show_name: eventName, event_id: 0,
    groups_v2: [], filters: buildEventFilter(filters, filterLogic), show_label: showLabel,
    event_indicator: "event_users", measure_info: {}, indicator_show_name: "",
  };
}

// 漏斗各步去重人数（整段汇总，不按天拆）。窗口期 = window_period 天。
// 返回 [第1步人数, 第2步人数, …]。
// 【为什么要用漏斗】「同一个人当天既做了 A 又做了 B」这种跨事件同人条件，事件分析接口表达不了
// （2026-08-19 逐一验过：option.fusion、profile_filters 里塞行为条件、各种 unordered 开关，全都无效）。
// ⚠️ 漏斗是**有序**的：只算「先 A 后 B」。无序交集拿不到，见 lib/xiaomei.mjs 里 beauty_* 的偏差说明。
export async function fetchFunnelUsers({ steps, period, profileExpressions = [], windowDays = 1, timezone, groupBy = null }) {
  const dsl = baseDsl({ period, profileExpressions, timezone });
  dsl.content.query_type = "funnel";
  dsl.content.queries = [steps];
  dsl.content.option.window_period = windowDays;
  dsl.content.option.window_period_type = "day";
  // 漏斗也支持按用户属性分组（实测 2026-08-20：media_source 分组的各组第二步之和 = 不分组的值）
  if (groupBy) dsl.content.profile_groups_v2.push({ property_type: "profile", property_name: groupBy });

  const json = await postAnalysis(dsl);
  if (json.code !== 200) throw new Error(`BytePlus funnel code=${json.code} ${json.message || ""}`);
  const d0 = json.data?.[0];
  if (d0?.result_status !== "SUCCESS") {
    throw new Error(`BytePlus funnel ${d0?.result_status || "无结果"} ${d0?.error_message || ""}`);
  }
  // summary_list = [分组名, 总转化率, 第1步人数, [第2步人数, 转化率], [第3步…], …]
  const parse = (s) => (s?.length ? [Number(s[2]) || 0, ...s.slice(3).map((x) => Number(Array.isArray(x) ? x[0] : x) || 0)] : steps.map(() => 0));
  if (groupBy) {
    return (d0.data_item_list || []).map((it) => ({ group: String(it.group_by_key ?? ""), counts: parse(it.summary_list) }));
  }
  return parse(d0.data_item_list?.[0]?.summary_list);
}
