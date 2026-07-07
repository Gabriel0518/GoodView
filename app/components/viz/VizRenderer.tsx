"use client";

// 统一渲染器：按 viz 类型分发；处理 loading/error/空态；底部展示口径标注与警告。
// 被搭建器预览与看板卡片共用。
import type { QueryRow, QueryMeta } from "../../lib/query-types";
import type { VizType } from "../../lib/metrics";
import { NumberCard } from "./NumberCard";
import { LineViz } from "./LineViz";
import { BarViz } from "./BarViz";
import { TableViz } from "./TableViz";
import { FunnelViz } from "./FunnelViz";

export function VizRenderer({
  viz,
  rows,
  meta,
  loading,
  error,
  note,
}: {
  viz: VizType;
  rows: QueryRow[];
  meta: QueryMeta | null;
  loading: boolean;
  error: string | null;
  note?: string; // 度量目录里的口径标注（如人次），即使无 meta 也可展示
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1">
        {error ? (
          <div className="py-6 text-center text-xs text-red-400">查询失败：{error}</div>
        ) : loading && !meta ? (
          <div className="py-8 text-center text-xs text-zinc-600">加载中…</div>
        ) : !meta ? (
          <div className="py-8 text-center text-xs text-zinc-600">配置卡片后预览</div>
        ) : (
          <div className={loading ? "opacity-60 transition-opacity" : "transition-opacity"}>
            <Body viz={viz} rows={rows} meta={meta} />
          </div>
        )}
      </div>
      <Footer meta={meta} note={note} />
    </div>
  );
}

function Body({ viz, rows, meta }: { viz: VizType; rows: QueryRow[]; meta: QueryMeta }) {
  switch (viz) {
    case "number":
      return <NumberCard rows={rows} meta={meta} />;
    case "line":
      return <LineViz rows={rows} meta={meta} />;
    case "bar":
      return <BarViz rows={rows} meta={meta} />;
    case "table":
      return <TableViz rows={rows} meta={meta} />;
    case "funnel":
      return <FunnelViz rows={rows} meta={meta} />;
    default:
      return null;
  }
}

function Footer({ meta, note }: { meta: QueryMeta | null; note?: string }) {
  const caption = meta?.note ?? note;
  const warnings = meta?.warnings ?? [];
  if (!caption && warnings.length === 0) return null;
  return (
    <div className="mt-2 space-y-1 border-t border-ink-800 pt-2">
      {caption && <p className="text-[11px] leading-snug text-zinc-600">ⓘ {caption}</p>}
      {warnings.map((w, i) => (
        <p key={i} className="text-[11px] leading-snug text-amber-400/80">
          ⚠ {w}
        </p>
      ))}
    </div>
  );
}
