// 度量目录 —— 引导式搭建器 + 服务端查询引擎的共享权威源。
// 编码两条命门（见 产品设计-v2.md §4 双立方体、§11 三类聚合）：
//   1) 每个度量属于一个「立方体」，决定它能配哪些维度（跨立方仅在 日期+渠道↔来源 对齐）。
//   2) 每个度量的聚合类型（可加/比值/人数）决定查询引擎怎么跨日期·维度聚合，绝不一律 SUM。

export type Cube = "spend" | "funnel" | "cross";
export type AggType = "additive" | "ratio" | "people";
export type Unit = "money" | "int" | "pct" | "ratio";
export type DimKey = "date" | "channel" | "account" | "campaign" | "adset" | "source" | "stage";
export type Granularity = "day" | "month" | "year";

// 维度元数据。cube 标注该维度属于哪个立方体（date 两边都有；跨立方用 channel↔source 对齐）。
export const DIM_META: Record<DimKey, { label: string; cube: "spend" | "funnel" | "both" }> = {
  date: { label: "日期", cube: "both" },
  channel: { label: "渠道", cube: "spend" },
  account: { label: "账户", cube: "spend" },
  campaign: { label: "系列", cube: "spend" },
  adset: { label: "广告组", cube: "spend" },
  source: { label: "来源", cube: "funnel" },
  stage: { label: "阶段", cube: "funnel" },
};

export type Measure = {
  key: string;
  label: string;
  group: string; // 分组标题：花费/流量 · 人数 · 单位成本 · 转化率
  cube: Cube;
  aggType: AggType;
  unit: Unit;
  allowedDims: DimKey[]; // 可作 X/Y/Z 的维度；引导式搭建器据此灰掉不兼容维度
  // 比值度量：以基础可加列表达的分子/分母。查询引擎算 SUM(num)/NULLIF(SUM(den),0)*scale，永不 SUM 比值本身。
  ratio?: { num: string; den: string; scale?: number };
  needsStage?: boolean; // people / unit_cost：需要 params.stage（stage_key）
  needsCvr?: boolean;   // cvr：需要 params.cvrFrom / params.cvrTo（两个 stage_key）
  note?: string;        // 口径标注（如"人次=日UV之和，非周期去重"）
};

// 花费立方体可用维度（date × 渠道 × 账户 × 系列 × 广告组）
const SPEND_DIMS: DimKey[] = ["date", "channel", "account", "campaign", "adset"];
// 人次口径标注（产品设计 §11 去重陷阱）
const PEOPLE_NOTE = "人次（日 UV 之和，跨日非真去重；一次性事件≈真去重，重复性事件高估）";

export const MEASURES: Measure[] = [
  // ---- 花费 / 流量（campaign_daily）----
  { key: "cost", label: "花费", group: "花费/流量", cube: "spend", aggType: "additive", unit: "money", allowedDims: SPEND_DIMS },
  { key: "impression", label: "曝光", group: "花费/流量", cube: "spend", aggType: "additive", unit: "int", allowedDims: SPEND_DIMS },
  { key: "click", label: "点击", group: "花费/流量", cube: "spend", aggType: "additive", unit: "int", allowedDims: SPEND_DIMS },
  { key: "cpm", label: "CPM", group: "花费/流量", cube: "spend", aggType: "ratio", unit: "money", allowedDims: SPEND_DIMS, ratio: { num: "cost", den: "impression", scale: 1000 } },
  { key: "ctr", label: "CTR", group: "花费/流量", cube: "spend", aggType: "ratio", unit: "pct", allowedDims: SPEND_DIMS, ratio: { num: "click", den: "impression" } },
  { key: "cpc", label: "CPC", group: "花费/流量", cube: "spend", aggType: "ratio", unit: "money", allowedDims: SPEND_DIMS, ratio: { num: "cost", den: "click" } },

  // ---- 人数（funnel_daily，按 stage 参数化）----
  // stage 既可作参数（固定一个阶段，按 date/source 拆），也可作维度（比较多个阶段）。
  { key: "people", label: "阶段人数", group: "人数", cube: "funnel", aggType: "people", unit: "int", allowedDims: ["date", "source", "stage"], needsStage: true, note: PEOPLE_NOTE },

  // ---- 转化率（funnel，A→B）----
  { key: "cvr", label: "阶段转化率", group: "转化率", cube: "funnel", aggType: "ratio", unit: "pct", allowedDims: ["date", "source"], needsCvr: true, note: "A→B 转化率 = SUM(B人次)/SUM(A人次)" },

  // ---- 单位成本（跨立方：渠道花费 ÷ 来源人数，仅 日期+渠道↔来源 对齐）----
  { key: "unit_cost", label: "单位转化成本", group: "单位成本", cube: "cross", aggType: "ratio", unit: "money", allowedDims: ["date", "channel"], needsStage: true, note: "渠道花费 ÷ 对应来源该阶段人数；仅 fb/tt 有花费↔来源映射" },
];

export const MEASURE_BY_KEY: Record<string, Measure> = Object.fromEntries(MEASURES.map((m) => [m.key, m]));

export function getMeasure(key: string): Measure | undefined {
  return MEASURE_BY_KEY[key];
}

// 某度量在给定维度上是否可选（引导式搭建器灰掉逻辑的判定）。
export function isDimAllowed(measureKey: string, dim: DimKey): boolean {
  return !!MEASURE_BY_KEY[measureKey]?.allowedDims.includes(dim);
}

// 度量分组（供搭建器按组展示）
export const MEASURE_GROUPS: string[] = ["花费/流量", "人数", "单位成本", "转化率"];

// 图表类型 —— 由度量 + 选中维度数量共同决定可用性（见 产品设计-v2.md §5）。
export type VizType = "number" | "line" | "bar" | "table" | "funnel";
export const VIZ_META: Record<VizType, { label: string; minDims: number; maxDims: number }> = {
  number: { label: "数字卡", minDims: 0, maxDims: 0 },
  line: { label: "折线", minDims: 1, maxDims: 2 },   // X=日期(+series 维度)
  bar: { label: "柱状", minDims: 1, maxDims: 2 },
  table: { label: "透视表", minDims: 1, maxDims: 3 },
  funnel: { label: "漏斗图", minDims: 1, maxDims: 1 }, // 特例：X=阶段
};
