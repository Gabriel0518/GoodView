// 服务端查询引擎 —— /api/query 的 SQL 生成核心。
// 命门（产品设计-v2.md §4/§11）：
//   · 按度量所属立方体路由到 campaign_daily / funnel_daily / 跨立方 join。
//   · 三类聚合硬编码：可加=SUM；比值=SUM(分子)/SUM(分母)，绝不 SUM 比值；人数=SUM 日UV（=人次）。
//   · 跨立方仅在 日期 + 渠道↔来源(fb↔facebook,tt↔tiktok) 对齐。
//   · 维度名不进 SQL 字符串拼接（白名单映射到固定列表达式），用户取值全部参数化。
import { withClient } from "./db";
import { getMeasure, type DimKey, type Granularity } from "./metrics";
import type { QueryRequest, QueryResponse, QueryRow, QueryFilters } from "./query-types";
import { resolveGroupToCampaignIds, type GroupMember } from "./groups";

// 渠道 ↔ 来源 对齐（跨立方唯一可 join 的映射）
const CHANNEL_OF_SOURCE: Record<string, string> = { fb: "facebook", tt: "tiktok" };
const SOURCE_OF_CHANNEL: Record<string, string> = { facebook: "fb", tiktok: "tt" };

// 日期 rollup 表达式（day 原样；month/year 用 date_trunc）
function dateExpr(col: string, gran: Granularity): string {
  if (gran === "day") return col;
  return `date_trunc('${gran === "year" ? "year" : "month"}', ${col})::date`;
}

const addDays = (ymd: string, n: number) => {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const WINDOW_DAYS: Record<string, number> = { d7: 7, d30: 30, d90: 90, d365: 365 };

// 花费立方体维度 → { 分组表达式, 输出取值表达式(可为聚合，取 label) }
const SPEND_DIM: Record<string, { group: (g: Granularity) => string; sel: (g: Granularity) => string }> = {
  date: { group: (g) => dateExpr("c.date", g), sel: (g) => `to_char(${dateExpr("c.date", g)},'YYYY-MM-DD')` },
  channel: { group: () => "c.channel", sel: () => "c.channel" },
  account: { group: () => "c.account_id", sel: () => "MAX(c.account_name)" },
  campaign: { group: () => "c.campaign_id", sel: () => "MAX(c.campaign_name)" },
  adset: { group: () => "c.adset_id", sel: () => "MAX(c.adset_name)" },
};
// 漏斗立方体维度
const FUNNEL_DIM: Record<string, { group: (g: Granularity) => string; sel: (g: Granularity) => string }> = {
  date: { group: (g) => dateExpr("f.date", g), sel: (g) => `to_char(${dateExpr("f.date", g)},'YYYY-MM-DD')` },
  source: { group: () => "f.source", sel: () => "f.source" },
  stage: { group: () => "f.stage_key", sel: () => "MAX(m.label)" },
};

// 取某表的日期范围（用于窗口钳制）
async function dateRange(c: import("pg").Client, table: "campaign_daily" | "funnel_daily") {
  const r = await c.query<{ mn: string | null; mx: string | null }>(
    `SELECT to_char(MIN(date),'YYYY-MM-DD') mn, to_char(MAX(date),'YYYY-MM-DD') mx FROM ${table}`,
  );
  return { min: r.rows[0]?.mn || null, max: r.rows[0]?.mx || null };
}

// 解析展示窗口：优先 custom(dateFrom/dateTo)，否则 window 预设；钳制到有数据范围。
function resolveWindow(filters: QueryFilters, range: { min: string | null; max: string | null }): { from: string; to: string } | null {
  if (!range.min || !range.max) return null;
  let from: string;
  let to = range.max;
  if (filters.window === "custom" && filters.dateFrom && filters.dateTo) {
    from = filters.dateFrom;
    to = filters.dateTo;
  } else {
    const days = WINDOW_DAYS[filters.window || "d30"] || 30;
    from = addDays(range.max, -(days - 1));
  }
  // 钳制
  if (from < range.min) from = range.min;
  if (to > range.max) to = range.max;
  if (from > to) from = to;
  return { from, to };
}

// 花费立方体过滤条件（date + channel/account/campaign/adset + group 解析）。返回 WHERE 片段 + 追加参数。
async function spendWhere(c: import("pg").Client, filters: QueryFilters, from: string, to: string) {
  const conds = ["c.date BETWEEN $1 AND $2"];
  const params: unknown[] = [from, to];
  let campaignIds: string[] | null = null;
  if (filters.groupId != null) {
    const g = await c.query<{ members: GroupMember[] }>(`SELECT members FROM ad_groups WHERE id = $1`, [filters.groupId]);
    if (g.rows[0]) campaignIds = await resolveGroupToCampaignIds(g.rows[0].members);
    else campaignIds = [];
  }
  if (campaignIds) { params.push(campaignIds); conds.push(`c.campaign_id = ANY($${params.length}::text[])`); }
  if (filters.accounts?.length) { params.push(filters.accounts); conds.push(`c.account_id = ANY($${params.length}::text[])`); }
  if (filters.campaigns?.length) { params.push(filters.campaigns); conds.push(`c.campaign_id = ANY($${params.length}::text[])`); }
  if (filters.adsets?.length) { params.push(filters.adsets); conds.push(`c.adset_id = ANY($${params.length}::text[])`); }
  if (filters.channels?.length) { params.push(filters.channels); conds.push(`c.channel = ANY($${params.length}::text[])`); }
  return { where: conds.join(" AND "), params };
}

// ---- 花费立方体查询 ----
function buildSpendSQL(measureKey: string, dims: DimKey[], gran: Granularity, whereSql: string) {
  const m = getMeasure(measureKey)!;
  let valueExpr: string;
  if (m.aggType === "additive") {
    valueExpr = `SUM(c.${measureKey})::float8`;
  } else {
    // ratio：SUM(分子)/NULLIF(SUM(分母),0)*scale，永不 SUM 比值
    const { num, den, scale } = m.ratio!;
    valueExpr = `(COALESCE(SUM(c.${num})/NULLIF(SUM(c.${den}),0),0)${scale ? ` * ${scale}` : ""})::float8`;
  }
  const selDims = dims.map((d) => `${SPEND_DIM[d].sel(gran)} AS ${d}`);
  const groupDims = dims.map((d) => SPEND_DIM[d].group(gran));
  const sql =
    `SELECT ${[...selDims, `${valueExpr} AS value`].join(", ")}
     FROM campaign_daily c
     WHERE ${whereSql}
     ${groupDims.length ? "GROUP BY " + groupDims.join(", ") : ""}
     ORDER BY ${dims.includes("date") ? "1" : "value DESC"}`;
  return sql;
}

// ---- 漏斗立方体查询（people / cvr）----
function buildFunnelSQL(req: QueryRequest, dims: DimKey[], gran: Granularity, from: string, to: string) {
  const m = getMeasure(req.measure)!;
  const conds = ["f.date BETWEEN $1 AND $2"];
  const params: unknown[] = [from, to];
  if (req.filters.sources?.length) { params.push(req.filters.sources); conds.push(`f.source = ANY($${params.length}::text[])`); }

  let valueExpr: string;
  if (m.key === "people") {
    // stage 作维度则按 stages 过滤集合；否则固定 params.stage
    if (dims.includes("stage")) {
      if (req.filters.stages?.length) { params.push(req.filters.stages); conds.push(`f.stage_key = ANY($${params.length}::text[])`); }
    } else {
      params.push(req.params?.stage); conds.push(`f.stage_key = $${params.length}`);
    }
    valueExpr = `SUM(f.count)::float8`;
  } else {
    // cvr：SUM(count filter stage=to)/NULLIF(SUM(count filter stage=from),0)
    params.push(req.params?.cvrFrom); const pi1 = params.length;
    params.push(req.params?.cvrTo); const pi2 = params.length;
    conds.push(`f.stage_key IN ($${pi1},$${pi2})`);
    valueExpr = `COALESCE(SUM(f.count) FILTER (WHERE f.stage_key=$${pi2})::numeric / NULLIF(SUM(f.count) FILTER (WHERE f.stage_key=$${pi1}),0),0)::float8`;
  }
  const selDims = dims.map((d) => `${FUNNEL_DIM[d].sel(gran)} AS ${d}`);
  const groupDims = dims.map((d) => FUNNEL_DIM[d].group(gran));
  const needMeta = dims.includes("stage");
  const sql =
    `SELECT ${[...selDims, `${valueExpr} AS value`].join(", ")}
     FROM funnel_daily f
     ${needMeta ? "JOIN funnel_stage_meta m ON m.stage_key = f.stage_key" : ""}
     WHERE ${conds.join(" AND ")}
     ${groupDims.length ? "GROUP BY " + groupDims.join(", ") : ""}
     ORDER BY ${dims.includes("date") ? "1" : "value DESC"}`;
  return { sql, params };
}

// ---- 跨立方查询（unit_cost = 渠道花费 ÷ 对应来源该阶段人数）----
async function buildCrossSQL(c: import("pg").Client, req: QueryRequest, dims: DimKey[], gran: Granularity, from: string, to: string) {
  // 花费侧（date, channel）+ 人数侧（date, source→channel）在 date+channel 上 join。仅 fb/tt 有映射。
  const sw = await spendWhere(c, req.filters, from, to);
  const params = [...sw.params];
  params.push(req.params?.stage); const stageIdx = params.length;
  // 输出维度只允许 date / channel
  const dateSel = `to_char(${dateExpr("j.date", gran)},'YYYY-MM-DD')`;
  const dimSelMap: Record<string, { sel: string; group: string }> = {
    date: { sel: dateSel, group: dateExpr("j.date", gran) },
    channel: { sel: "j.channel", group: "j.channel" },
  };
  const selDims = dims.map((d) => `${dimSelMap[d].sel} AS ${d}`);
  const groupDims = dims.map((d) => dimSelMap[d].group);
  const sql =
    `WITH spend AS (
       SELECT c.date, c.channel, SUM(c.cost) AS cost
       FROM campaign_daily c WHERE ${sw.where} AND c.channel = ANY($${stageIdx + 1}::text[])
       GROUP BY c.date, c.channel
     ),
     ppl AS (
       SELECT f.date, f.source, SUM(f.count) AS ppl
       FROM funnel_daily f WHERE f.date BETWEEN $1 AND $2 AND f.stage_key = $${stageIdx}
       GROUP BY f.date, f.source
     ),
     j AS (
       SELECT s.date, s.channel, s.cost, p.ppl
       FROM spend s JOIN ppl p ON p.date = s.date
         AND p.source = CASE s.channel WHEN 'facebook' THEN 'fb' WHEN 'tiktok' THEN 'tt' END
     )
     SELECT ${[...selDims, `COALESCE(SUM(j.cost)/NULLIF(SUM(j.ppl),0),0)::float8 AS value`].join(", ")}
     FROM j
     ${groupDims.length ? "GROUP BY " + groupDims.join(", ") : ""}
     ORDER BY ${dims.includes("date") ? "1" : "value DESC"}`;
  // 跨立方只算 fb/tt 对应的渠道
  params.push(["facebook", "tiktok"]);
  return { sql, params };
}

export async function runQuery(req: QueryRequest): Promise<QueryResponse> {
  const m = getMeasure(req.measure);
  if (!m) throw new Error(`未知度量：${req.measure}`);
  const dims = (req.dims || []).slice(0, 3);
  for (const d of dims) if (!m.allowedDims.includes(d)) throw new Error(`度量「${m.label}」不支持维度「${d}」`);
  if (m.needsStage && !dims.includes("stage") && !req.params?.stage) throw new Error(`度量「${m.label}」需要指定阶段`);
  if (m.needsCvr && (!req.params?.cvrFrom || !req.params?.cvrTo)) throw new Error(`转化率需要起止两个阶段`);
  const gran: Granularity = req.filters?.granularity || "day";
  const warnings: string[] = [];

  return withClient(async (c) => {
    const table = m.cube === "funnel" ? "funnel_daily" : "campaign_daily";
    const range = await dateRange(c, table);
    const win = resolveWindow(req.filters || { granularity: gran }, range);
    if (!win) return { rows: [], meta: { measure: m.key, cube: m.cube, aggType: m.aggType, unit: m.unit, dims, granularity: gran, dateFrom: "", dateTo: "", rowCount: 0, note: m.note } };

    let sql: string;
    let params: unknown[];
    if (m.cube === "spend") {
      const sw = await spendWhere(c, req.filters, win.from, win.to);
      sql = buildSpendSQL(m.key, dims, gran, sw.where);
      params = sw.params;
    } else if (m.cube === "funnel") {
      const b = buildFunnelSQL(req, dims, gran, win.from, win.to);
      sql = b.sql; params = b.params;
    } else {
      const b = await buildCrossSQL(c, req, dims, gran, win.from, win.to);
      sql = b.sql; params = b.params;
      warnings.push("跨立方：仅 fb/tt 有 渠道↔来源 映射；bff/AIguild/google 不计入");
    }

    const res = await c.query<QueryRow>(sql, params as never[]);
    const rows = res.rows.map((r) => ({ ...r, value: Number(r.value) || 0 }));
    return {
      rows,
      meta: {
        measure: m.key, cube: m.cube, aggType: m.aggType, unit: m.unit,
        dims, granularity: gran, dateFrom: win.from, dateTo: win.to, rowCount: rows.length,
        note: m.note, warnings: warnings.length ? warnings : undefined,
      },
    };
  });
}
