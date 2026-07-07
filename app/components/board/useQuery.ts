"use client";

// /api/query 客户端 hook —— 唯一数据路径（无客户端聚合）。
// 传入 QueryRequest（或 null 跳过）；按序列化后的请求体做去重/取消。
import { useEffect, useState } from "react";
import type { QueryRequest, QueryResponse, QueryMeta, QueryRow } from "../../lib/query-types";

export type UseQueryState = {
  rows: QueryRow[];
  meta: QueryMeta | null;
  loading: boolean;
  error: string | null;
};

const IDLE: UseQueryState = { rows: [], meta: null, loading: false, error: null };

export function useQuery(req: QueryRequest | null): UseQueryState {
  const [state, setState] = useState<UseQueryState>(IDLE);
  // 序列化请求作为唯一依赖：既做去重（同请求不重发），又作为 fetch body。
  const key = req ? JSON.stringify(req) : null;

  useEffect(() => {
    if (!key) {
      setState(IDLE);
      return;
    }
    let alive = true;
    const ctrl = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));
    fetch("/api/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: key,
      cache: "no-store",
      signal: ctrl.signal,
    })
      .then(async (res) => {
        const json = (await res.json().catch(() => null)) as (QueryResponse & { error?: string }) | null;
        if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
        if (!json) throw new Error("空响应");
        return json as QueryResponse;
      })
      .then((data) => {
        if (alive) setState({ rows: data.rows ?? [], meta: data.meta ?? null, loading: false, error: null });
      })
      .catch((e: unknown) => {
        if (!alive) return;
        const err = e as { name?: string; message?: string };
        if (err?.name === "AbortError") return;
        setState({ rows: [], meta: null, loading: false, error: String(err?.message || e) });
      });
    return () => {
      alive = false;
      ctrl.abort();
    };
  }, [key]);

  return state;
}
