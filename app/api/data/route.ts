import { NextResponse } from "next/server";
import { checkAuth, CAVEATS, DEFAULT_LIMIT, MAX_LIMIT } from "../../lib/data-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/data —— API 自述文档。给「其他 AI」当入口：一次拿到端点、鉴权方式、口径警告和示例。
// 设计意图：外部 AI 不了解本项目的口径坑（时区错位、含回访的注册、埋点断档…），
// 只给数据不给口径，它会自信地算出错误结论。所以 caveats 是这个接口的主体内容，不是附注。
export async function GET(req: Request) {
  const auth = checkAuth(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  return NextResponse.json({
    name: "GoodView 只读数据 API",
    description:
      "广告投放与转化漏斗数据仓库（Postgres）的只读访问。数据来自三个上游：XMP(广告投放) / BytePlus(前端埋点事件) / 自有后台业务库(真实业务记录)。",
    auth: "所有端点需要 Authorization: Bearer <token>，或 ?token=<token>",
    endpoints: [
      { method: "GET", path: "/api/data", desc: "本文档" },
      { method: "GET", path: "/api/data/schema", desc: "全部表的字段、类型、约行数，以及每张表的口径说明" },
      {
        method: "POST",
        path: "/api/data/query",
        desc: "执行只读 SQL",
        body: { sql: "SELECT ...", limit: `可选，默认 ${DEFAULT_LIMIT}，上限 ${MAX_LIMIT}` },
        returns: { columns: ["列名"], rows: [{}], rowCount: 0, truncated: false, elapsedMs: 0 },
        limits: [
          "只允许单条 SELECT / WITH 查询",
          "在 READ ONLY 事务中执行，任何写操作或 DDL 都会被 Postgres 拒绝",
          "语句超时 15 秒",
          `返回行数上限 ${MAX_LIMIT}；超出时 truncated=true，请自行加 LIMIT 或聚合`,
        ],
      },
    ],
    important_caveats: CAVEATS,
    tips: [
      "先调 GET /api/data/schema 看表结构和每张表的 note，再写 SQL。",
      "分析趋势请按周或按月聚合，不要逐日拉明细——campaign_daily 有 27 万行、funnel_daily 有 13.7 万行。",
      "涉及「单价」的计算，务必先读 important_caveats 里的时区错位与最新一天不完整两条。",
      "问「昨天/今天」之前，先跑 SELECT max(date) FROM key_metric_daily 和 SELECT max(date) FROM campaign_daily WHERE cost>0 确认各源的数据边界。",
    ],
    examples: [
      {
        desc: "近 14 天 PWA 花费与注册（注意两者时区不同，单价为近似值）",
        sql: "WITH s AS (SELECT date, SUM(cost) cost FROM campaign_daily WHERE date > CURRENT_DATE - 14 AND (campaign_name ~* 'pwa|sitin' OR account_name ~* 'pwa|sitin') GROUP BY date), r AS (SELECT date, count FROM dms_metric_daily WHERE metric_key='register' AND date > CURRENT_DATE - 14) SELECT s.date, round(s.cost,2) cost, r.count AS reg, round(s.cost/NULLIF(r.count,0),2) AS cpr FROM s LEFT JOIN r ON r.date=s.date ORDER BY s.date DESC",
      },
      {
        desc: "德州 vs 非德州 vs 全量 的关键指标（近 7 天）",
        sql: "SELECT date, region, max(count) FILTER (WHERE metric_key='register') reg, max(count) FILTER (WHERE metric_key='ig_auth') ig_auth, max(count) FILTER (WHERE metric_key='ig_bind') ig_bind FROM key_metric_daily WHERE date > CURRENT_DATE - 7 GROUP BY date, region ORDER BY date DESC, region",
      },
      {
        desc: "漏斗各阶段近 7 天人数（排除 AI公会来源）",
        sql: "SELECT m.ord, m.label, SUM(f.count) n FROM funnel_daily f JOIN funnel_stage_meta m ON m.stage_key=f.stage_key WHERE f.date > CURRENT_DATE - 7 AND f.source NOT IN ('AIguild','AIguild_active','AIguild_passive') GROUP BY m.ord, m.label ORDER BY m.ord",
      },
    ],
  });
}
