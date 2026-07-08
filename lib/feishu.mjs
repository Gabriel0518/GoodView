// 飞书多维表格（Bitable）开放接口客户端。
// 仅覆盖同步所需：tenant_access_token（缓存）、建表、列表、记录批量增删、按数字范围检索。
// 复用 lib/http.mjs 的 fetchRetry（兜网络抖动）；HTTP 层错误（code!=0）直接抛。
import { FEISHU } from "../config.mjs";
import { fetchRetry } from "./http.mjs";

const BASE = `${FEISHU.host}/open-apis`;

// —— tenant_access_token：缓存到过期前 60s ——
let _tok = { value: "", exp: 0 };
async function token() {
  if (_tok.value && Date.now() < _tok.exp) return _tok.value;
  if (!FEISHU.appId || !FEISHU.appSecret) throw new Error("缺少 FEISHU_APP_ID / FEISHU_APP_SECRET");
  const res = await fetchRetry(`${BASE}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: FEISHU.appId, app_secret: FEISHU.appSecret }),
  });
  const j = await res.json();
  if (j.code !== 0) throw new Error(`飞书鉴权失败：${j.code} ${j.msg}`);
  _tok = { value: j.tenant_access_token, exp: Date.now() + (j.expire - 60) * 1000 };
  return _tok.value;
}

// —— 通用请求：带 token；token 失效(99991663/99991661)刷新重试；瞬时错误(data not ready/并发/频控)退避重试 ——
const TRANSIENT_CODES = new Set([1254607, 1254291, 1254290, 1255001, 1255002, 1255003]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body, _retried = false, attempt = 0) {
  const t = await token();
  const res = await fetchRetry(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json; charset=utf-8" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({ code: -1, msg: `HTTP ${res.status}（响应非 JSON）` }));
  if (j.code === 99991663 || j.code === 99991661) {
    _tok = { value: "", exp: 0 };
    if (!_retried) return api(method, path, body, true, attempt);
  }
  if (TRANSIENT_CODES.has(j.code) && attempt < 4) {
    await sleep(800 * (attempt + 1));
    return api(method, path, body, _retried, attempt + 1);
  }
  if (j.code !== 0) throw new Error(`飞书接口 ${method} ${path} 失败：${j.code} ${j.msg}`);
  return j.data;
}

const app = () => {
  if (!FEISHU.appToken) throw new Error("缺少 FEISHU_APP_TOKEN（目标多维表格 app_token）");
  return FEISHU.appToken;
};

// —— 表：列出 / 创建 ——
export async function listTables() {
  const out = [];
  let pageToken = "";
  do {
    const qs = new URLSearchParams({ page_size: "100", ...(pageToken ? { page_token: pageToken } : {}) });
    const data = await api("GET", `/bitable/v1/apps/${app()}/tables?${qs}`);
    out.push(...(data.items || []));
    pageToken = data.has_more ? data.page_token : "";
  } while (pageToken);
  return out; // [{ table_id, name, revision }]
}

// fields: [{ field_name, type, ui_type?, property? }]。返回 table_id。
export async function createTable(name, fields) {
  const data = await api("POST", `/bitable/v1/apps/${app()}/tables`, {
    table: { name, default_view_name: "表格", fields },
  });
  return data.table_id;
}

// name → table_id 映射（同步运行时解析，无需持久化）
export async function tableIdMap() {
  const map = {};
  for (const t of await listTables()) map[t.name] = t.table_id;
  return map;
}

// —— 记录：批量创建（≤1000/次）——
export async function batchCreate(tableId, records, chunk = 500) {
  let n = 0;
  for (let i = 0; i < records.length; i += chunk) {
    const slice = records.slice(i, i + chunk).map((fields) => ({ fields }));
    const data = await api("POST", `/bitable/v1/apps/${app()}/tables/${tableId}/records/batch_create`, { records: slice });
    n += (data.records || []).length;
  }
  return n;
}

// —— 记录：批量删除（≤500/次）——
export async function batchDelete(tableId, recordIds, chunk = 500) {
  let n = 0;
  for (let i = 0; i < recordIds.length; i += chunk) {
    const slice = recordIds.slice(i, i + chunk);
    await api("POST", `/bitable/v1/apps/${app()}/tables/${tableId}/records/batch_delete`, { records: slice });
    n += slice.length;
  }
  return n;
}

// —— 记录：全表 record_id（配置类小表全量替换用）——
export async function listAllRecordIds(tableId) {
  return searchRecordIds(tableId, undefined);
}

// —— 记录：按数字字段区间检索 record_id（窗口删除用）——
// 用整数 YYYYMMDD 的 number 字段做范围过滤，避开飞书日期过滤的特殊格式。
// 飞书 number 无 >=/<=，用 isGreater(from-1)/isLess(to+1) 模拟闭区间。
export async function searchRecordIdsByDateNum(tableId, field, fromNum, toNum) {
  const filter = {
    conjunction: "and",
    conditions: [
      { field_name: field, operator: "isGreater", value: [String(fromNum - 1)] },
      { field_name: field, operator: "isLess", value: [String(toNum + 1)] },
    ],
  };
  return searchRecordIds(tableId, filter);
}

async function searchRecordIds(tableId, filter) {
  const ids = [];
  let pageToken = "";
  do {
    const qs = new URLSearchParams({ page_size: "500", ...(pageToken ? { page_token: pageToken } : {}) });
    const body = { field_names: [], ...(filter ? { filter } : {}) };
    const data = await api("POST", `/bitable/v1/apps/${app()}/tables/${tableId}/records/search?${qs}`, body);
    for (const r of data.items || []) ids.push(r.record_id);
    pageToken = data.has_more ? data.page_token : "";
  } while (pageToken);
  return ids;
}

// —— 字段类型码（飞书 Bitable）——
export const FT = { TEXT: 1, NUMBER: 2, SINGLE_SELECT: 3, MULTI_SELECT: 4, DATE: 5, CHECKBOX: 7 };

// —— 值助手 ——
// 日期字段值 = UTC 零点毫秒时间戳；输入 'YYYY-MM-DD'
export const dateMs = (ymd) => Date.parse(`${ymd}T00:00:00Z`);
// 整数 YYYYMMDD（number 字段，供范围过滤/窗口删除）
export const dateNum = (ymd) => Number(ymd.replace(/-/g, ""));
