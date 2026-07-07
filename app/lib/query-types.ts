// /api/query 契约 —— 服务端查询引擎 ↔ 前端搭建器/看板的冻结接口。
// 前端把「透视配置」发给 POST /api/query，后端按度量所属立方体拼 SQL 聚合后返回行。
// 替代 v1 的"塞全量、前端算"。见 实现计划-v2.md P2.1、DEV-AGENTS §3 契约2。
import type { AggType, Cube, DimKey, Granularity } from "./metrics";

// 看板/卡片共享的筛选上下文。看板级=底，卡片级可再细化（前端合并后下发）。
export type QueryFilters = {
  dateFrom?: string;      // YYYY-MM-DD（含）；缺省由 window 决定
  dateTo?: string;        // YYYY-MM-DD（含）
  window?: "d7" | "d30" | "d90" | "d365" | "custom"; // 快捷窗口；custom 用 dateFrom/dateTo
  granularity: Granularity; // 日/月/年 rollup（date_trunc）
  // 数据源（花费立方体）：groupId 优先（分组解析为去重 campaign_id 集合），否则 accounts/campaigns/adsets
  groupId?: number;
  accounts?: string[];
  campaigns?: string[];
  adsets?: string[];
  channels?: string[];    // facebook/tiktok/google
  // 漏斗立方体
  sources?: string[];     // fb/tt/bff/AIguild/.../unknown
  stages?: string[];      // 限定 stage_key 集合
};

// 度量参数（people/unit_cost 需 stage；cvr 需 from/to）。
export type QueryParams = {
  stage?: string;         // people / unit_cost：stage_key
  cvrFrom?: string;       // cvr：起始 stage_key
  cvrTo?: string;         // cvr：目标 stage_key
};

export type QueryRequest = {
  measure: string;        // MEASURES 里的 key
  params?: QueryParams;
  dims: DimKey[];         // 0..3 个分组维度（顺序 = X, series/Y, Z）；必须 ⊆ 该度量 allowedDims
  filters: QueryFilters;
};

// 一行 = 各维度取值 + 度量值。维度值用 dimKey 作字段名（date/channel/source/stage/…）。
export type QueryRow = { value: number } & Partial<Record<DimKey, string>>;

export type QueryMeta = {
  measure: string;
  cube: Cube;
  aggType: AggType;
  unit: string;
  dims: DimKey[];
  granularity: Granularity;
  dateFrom: string;       // 引擎实际用的窗口（钳制到有数据范围后）
  dateTo: string;
  rowCount: number;
  note?: string;          // 口径标注（人次、跨立方对齐限制等）
  warnings?: string[];    // 如"google 无来源""bff/AIguild 无花费"
};

export type QueryResponse = {
  rows: QueryRow[];
  meta: QueryMeta;
};

// 错误响应（与现有 /api/groups 风格一致）
export type QueryError = { error: string };
