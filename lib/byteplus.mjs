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

async function runAnalysis(dsl) {
  const body = JSON.stringify(dsl);
  for (let attempt = 0; ; attempt++) {
    try {
      // fetch + res.json() 同在重试内：undici 会在读 body 阶段抛 terminated。
      const res = await fetchRetry(BYTEPLUS.host + URI, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader("POST", URI, "", body) },
        body,
      });
      const json = await res.json();
      if (json.code !== 200) {
        throw new Error(`BytePlus code=${json.code} ${json.message || JSON.stringify(json)}`);
      }
      return json.data?.[0];
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

function baseDsl({ lastDays }) {
  return {
    use_app_cloud_id: true,
    app_ids: [BYTEPLUS.appId],
    version: 3,
    periods: [
      { granularity: "day", type: "last", last: { amount: lastDays, unit: "day" }, timezone: BYTEPLUS.timezone },
    ],
    content: {
      profile_groups_v2: [],
      profile_filters: [],
      orders: [],
      query_type: "event",
      queries: [[]],
      page: { limit: 1000, offset: 0 }, // 分组数量上限，默认 50 会截断小分组(如 AIguild)
      option: { refresh_cache: false, fusion: false },
    },
  };
}

// 单序列（不分组）：返回 [{ date, count }]
export async function fetchEventDaily({ eventName, lastDays, indicator = "event_users" }) {
  const dsl = baseDsl({ lastDays });
  dsl.content.queries = [[eventQuery({ eventName, indicator })]];
  const q = await runAnalysis(dsl);
  const dates = q?.date_index_list || [];
  const vals = q?.data_item_list?.[0]?.data || [];
  return dates.map((d, i) => ({ date: fmtDate(d), count: Number(vals[i]) || 0 }));
}

// 按属性分组（默认用户属性 profile source）+ 可选事件属性过滤（event_param）。
// groupBy 分组字段；propertyType 分组属性类型（"profile" 用户属性 / "event_param" 事件属性）；
// filters 事件属性过滤数组，形如 [{ property_name, values, operation }]，property_type 默认 event_param。
// 返回 { dates:[...], series:[{ group, data:[], sum }] }
export async function fetchEventDailyGrouped({
  eventName, lastDays, groupBy,
  propertyType = "profile", groupLocation = "content", indicator = "event_users",
  filters = [], rawFilters = null, groups = null,
}) {
  const evFilters = rawFilters || filters.map((f) => ({
    property_type: f.property_type || "event_param",
    property_name: f.property_name,
    property_operation: f.operation || "=",
    values: f.values,
  }));

  const dsl = baseDsl({ lastDays });
  const q = eventQuery({ eventName, indicator, filters: evFilters });

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
