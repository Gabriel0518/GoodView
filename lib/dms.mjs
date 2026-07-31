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
    return (d.rows || []).map((r) => Object.fromEntries(cols.map((c, i) => [c, r[`c${i}`]])));
  }
}

// 把业务库的 UTC 裸时间列按目标时区切成日历日的 SQL 片段。
export const dayExpr = (col, tz) => `((${col} AT TIME ZONE '${DMS.dbTimezone}') AT TIME ZONE '${tz}')::date`;
