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
const IS_TEST = {
  expression: {
    logic: "and",
    expressions: [
      { logic: "or", conditions: [{ property_type: "profile", property_name: "is_test", property_compose_type: "origin", property_operation: "!=", property_values: ["true"] }] },
      { logic: "or", conditions: [{ property_type: "event_param", property_name: "isTest", property_compose_type: "origin", property_operation: "!=", property_values: ["true"] }] },
    ],
  },
};

// 事件属性过滤 → 官方格式（expression/logic/conditions + property_values；扁平写法会被静默忽略）。
// filters = [{property, values, operation?, property_type?}]；【多条放进同一 OR 组】= 跨属性/多值 OR，
// 用于"成材 = withdraw_amount=25 OR will_cashout_stage=CashoutStageFive"（数据口径 §4.4）。
export function buildEventFilter(filters) {
  if (!filters || !filters.length) return [];
  const conditions = filters.map((f) => ({
    property_type: f.property_type || "event_param",
    property_name: f.property,
    property_compose_type: "origin",
    property_operation: f.operation || "=",
    property_values: f.values,
  }));
  return [{ expression: { logic: "and", expressions: [{ logic: "or", conditions }] } }];
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

function baseDsl({ lastDays, period }) {
  return {
    use_app_cloud_id: true,
    app_ids: [BYTEPLUS.appId],
    version: 3,
    // 默认按天取最近 N 天；传 period 则用自定义时间段（如固定起止 + 整段去重）
    periods: [
      period || { granularity: "day", type: "last", last: { amount: lastDays, unit: "day" }, timezone: BYTEPLUS.timezone },
    ],
    content: {
      profile_groups_v2: [],
      profile_filters: [IS_TEST], // 官方口径：始终排除测试用户
      orders: [],
      query_type: "event",
      queries: [[]],
      page: { limit: 1000, offset: 0 }, // 分组数量上限，默认 50 会截断小分组(如 AIguild)
      option: { refresh_cache: false, fusion: false },
    },
  };
}

// 单序列（不分组）：返回 [{ date, count }]。filters=事件属性过滤定义（[{property,values}]）。
export async function fetchEventDaily({ eventName, lastDays, indicator = "event_users", filters = null }) {
  const dsl = baseDsl({ lastDays });
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
}) {
  const dsl = baseDsl({ lastDays, period });
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
