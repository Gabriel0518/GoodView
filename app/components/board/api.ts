"use client";

// 看板/卡片/元数据 REST 封装。所有形状对齐 Lead 提供的契约。
import type { Card, CardConfig, CardLayout, BoardFilters, Dashboard, StageMeta, BoardGroup } from "./types";

export async function jfetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error((json && (json.error as string)) || `HTTP ${res.status}`);
  return json as T;
}

const jbody = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

// ── 看板 ─────────────────────────────────────────────
export const listDashboards = () => jfetch<Dashboard[]>("/api/dashboards");
export const createDashboard = (name: string, board_filters?: BoardFilters) =>
  jfetch<{ id: number }>("/api/dashboards", jbody("POST", { name, board_filters }));
// 注：契约 PUT 列出 {name?,board_filters?}；is_template 为前向兼容附加项（存模板用），后端未支持则忽略。
export const updateDashboard = (
  id: number,
  patch: { name?: string; board_filters?: BoardFilters; is_template?: boolean },
) => jfetch<unknown>("/api/dashboards", jbody("PUT", { id, ...patch }));
export const deleteDashboard = (id: number) =>
  jfetch<unknown>(`/api/dashboards?id=${encodeURIComponent(id)}`, { method: "DELETE" });
export const copyDashboard = (id: number) => jfetch<{ id: number }>("/api/dashboards/copy", jbody("POST", { id }));

// ── 卡片 ─────────────────────────────────────────────
export const listCards = (dashboardId: number) => jfetch<Card[]>(`/api/dashboards/${dashboardId}/cards`);
export const createCard = (dashboardId: number, title: string, config: CardConfig, layout?: CardLayout) =>
  jfetch<{ id: number }>(`/api/dashboards/${dashboardId}/cards`, jbody("POST", { title, config, layout }));
export const updateCard = (
  dashboardId: number,
  id: number,
  patch: { title?: string; config?: CardConfig; layout?: CardLayout; ord?: number },
) => jfetch<unknown>(`/api/dashboards/${dashboardId}/cards`, jbody("PUT", { id, ...patch }));
export const deleteCard = (dashboardId: number, cardId: number) =>
  jfetch<unknown>(`/api/dashboards/${dashboardId}/cards?cardId=${encodeURIComponent(cardId)}`, { method: "DELETE" });

// ── 元数据 ───────────────────────────────────────────
export const listGroups = () => jfetch<BoardGroup[]>("/api/groups");

// 阶段列表：后端 GET /api/meta/stages。开发期若 404 优雅降级为空。
export async function getStages(): Promise<StageMeta[]> {
  try {
    const data = await jfetch<StageMeta[]>("/api/meta/stages");
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}
