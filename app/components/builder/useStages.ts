"use client";

// 阶段列表 hook（people/unit_cost 的 stage 参数、cvr 的 from/to 选择）。
// 数据来自 GET /api/meta/stages；开发期若 404 优雅降级为空数组。
import { useEffect, useState } from "react";
import type { StageMeta } from "../board/types";
import { getStages } from "../board/api";

export function useStages(): { stages: StageMeta[]; loading: boolean } {
  const [stages, setStages] = useState<StageMeta[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    getStages().then((s) => {
      if (alive) {
        setStages(s);
        setLoading(false);
      }
    });
    return () => {
      alive = false;
    };
  }, []);
  return { stages, loading };
}
