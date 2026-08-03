// 自有后台业务库（阿里云 DMS 只读 SQL 接口）取数模块。
//
// 接口：POST {endpoint}，Bearer token，body {"sql": "..."}。**只放行 SELECT**（SHOW TABLES 等无输出）。
// 返回两种形态，都要处理：
//   成功 {"success":true,"data":{"columns":["a","b"],"fields":["c0","c1"],"rows":[{"c0":..,"c1":..}]}}
//   SQL 错 {"success":true,"data":{"error":"syntax error at or near ..."}}  ← success 仍是 true，别只看它
//
// 坑（实测）：
//   · 列名在 `columns`、值的键却是 `c0/c1/...`，要自己映射回来（本模块 rows() 已做）。
//   · 别用 `day` 之类保留字做列别名 → `syntax error at or near "day"`。
//   · 文本列跟数字比较会报 `operator does not exist: character varying = integer`
//     （task_id/amount 都是 varchar）→ 字面量一律写成字符串 '110' / '25'。
//   · 时间列是 `timestamp without time zone`、存的是 UTC 裸时间。要按目标时区切日必须写
//     `(ts AT TIME ZONE 'UTC') AT TIME ZONE '<目标时区>'`；只写后半段是把裸时间**当成**目标时区，方向反了。
import { DMS } from "../config.mjs";
import { fetchRetry, isTransient } from "./http.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const enabled = () => Boolean(DMS.token);

// 跑一条 SQL，返回 [{列名: 值}]。SQL 报错抛异常（含原始 message，便于定位）。
export async function query(sql) {
  if (!DMS.token) throw new Error("缺少 DMS_TOKEN（见 .env.example）");
  const body = JSON.stringify({ sql });
  for (let attempt = 0; ; attempt++) {
    let json;
    try {
      const res = await fetchRetry(DMS.endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${DMS.token}`, "Content-Type": "application/json" },
        body,
      });
      json = await res.json();
    } catch (e) {
      if (isTransient(e) && attempt < 5) {
        const wait = 1000 + attempt * 1500;
        console.warn(`  ⚠️ DMS 网络抖动(${e?.cause?.code || e?.message})，${Math.round(wait / 1000)}s 后重试…`);
        await sleep(wait);
        continue;
      }
      throw e;
    }
    const d = json?.data;
    if (json?.success !== true || !d) throw new Error(`DMS 接口失败：${JSON.stringify(json).slice(0, 200)}`);
    if (d.error) throw new Error(`DMS SQL 错误：${d.error}`);
    const cols = d.columns || [];
    const out = (d.rows || []).map((r) => Object.fromEntries(cols.map((c, i) => [c, r[`c${i}`]])));
    // 正好 1000 行几乎一定是撞上了接口硬上限（静默截断）。宁可误报也不能让名单悄悄缺人。
    if (out.length === 1000 && !/\bLIMIT\s+1000\b/i.test(sql)) {
      console.warn("  ⚠️ DMS 返回正好 1000 行 —— 接口上限，结果可能被截断。明细查询请改用 queryAll() 分页。");
    }
    return out;
  }
}

// 把业务库的 UTC 裸时间列按目标时区切成日历日的 SQL 片段。
export const dayExpr = (col, tz) => `((${col} AT TIME ZONE '${DMS.dbTimezone}') AT TIME ZONE '${tz}')::date`;

// ⚠️ DMS 接口把**所有**列都返回成字符串，布尔值是 "true"/"false" 而不是 true/false。
//    直接 `if (row.flag)` 对 "false" 判真 —— 必须用这个 helper。
//    （2026-08-03 踩过：536 人的名单被整份判成"已注销"。）
export const bool = (v) => v === true || v === "true" || v === "t" || v === 1 || v === "1";
// 数值列同理是字符串，参与运算前先转。
export const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

// ⚠️ 接口硬上限 1000 行，**超出静默截断、不报错**（实测 LIMIT 1500 只回 1000）。
//    明细查询超过 1000 行必须用 queryAll 分页，否则名单会缺人而看不出来。
//    （2026-08-03 踩过：face_score>=80 队列实为 1059 人，导出成了 1000。）
export const DMS_MAX_ROWS = 1000;

// 分页取全量。orderBy 必填：没有稳定排序，LIMIT/OFFSET 翻页会漏行或重行。
export async function queryAll(sql, { orderBy, pageSize = DMS_MAX_ROWS } = {}) {
  if (!orderBy) throw new Error("queryAll 必须传 orderBy（分页需要稳定排序）");
  const out = [];
  for (let off = 0; ; off += pageSize) {
    const page = await query(
      `SELECT * FROM (${sql}) _pg ORDER BY ${orderBy} LIMIT ${pageSize} OFFSET ${off}`,
    );
    out.push(...page);
    if (page.length < pageSize) break;
  }
  return out;
}
