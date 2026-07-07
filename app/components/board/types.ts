// 前端共享类型 —— 严格对齐冻结契约（query-types.ts / metrics.ts）。
// 看板/卡片的持久化形状（config/layout）与 P2.3 schema 一致。
import type { QueryFilters, QueryParams } from "../../lib/query-types";
import type { DimKey, VizType } from "../../lib/metrics";

// 卡片配置（存 cards.config JSONB）
export type CardConfig = {
  measure: string;
  params?: QueryParams;
  dims: DimKey[];
  viz: VizType;
  cardFilters?: Partial<QueryFilters>;
};

// 栅格位置（存 cards.layout JSONB）
export type CardLayout = { x: number; y: number; w: number; h: number };

export type Card = {
  id: number;
  title: string;
  config: CardConfig;
  layout: CardLayout | null;
  ord: number;
};

// 看板级筛选 = 所有卡片查询的「底」。用 QueryFilters（granularity 必填）。
export type BoardFilters = QueryFilters;

export type Dashboard = {
  id: number;
  name: string;
  board_filters: BoardFilters | null;
  is_template: boolean;
};

// GET /api/meta/stages
export type StageMeta = { stage_key: string; label: string; ord: number };

// GET /api/groups（仅取搭建器/看板需要的字段）
export type BoardGroup = { id: number; name: string; is_app_group?: boolean };

export const DEFAULT_BOARD_FILTERS: BoardFilters = { window: "d30", granularity: "day" };

// 看板级筛选（底）+ 卡片级筛选（细化）合并 → 下发给 /api/query。
// 卡片级已定义的键覆盖看板级；granularity 始终有值。
export function mergeFilters(board: BoardFilters | null | undefined, card?: Partial<QueryFilters>): QueryFilters {
  const b: BoardFilters = board ?? DEFAULT_BOARD_FILTERS;
  const merged: QueryFilters = { ...b, ...(card ?? {}) };
  merged.granularity = card?.granularity ?? b.granularity;
  return merged;
}
