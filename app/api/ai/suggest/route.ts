import { NextResponse } from "next/server";
import { kimiChat, kimiConfigured } from "../../../lib/kimi";
import { buildBoardContext, contextToText } from "../../../lib/ai-context";
import { MEASURES, getMeasure, VIZ_META, type DimKey } from "../../../lib/metrics";

export const dynamic = "force-dynamic";

type Suggestion = { title: string; measure: string; params?: { stage?: string; cvrFrom?: string; cvrTo?: string }; dims: DimKey[]; viz: string; reason: string };

// 校验建议合法（度量存在、维度⊆allowedDims、viz 维度数匹配），过滤非法项。
function validate(s: Suggestion): boolean {
  if (!s || typeof s !== "object") return false;
  const m = getMeasure(s.measure);
  if (!m || !Array.isArray(s.dims)) return false;
  if (!s.dims.every((d) => m.allowedDims.includes(d))) return false;
  const v = VIZ_META[s.viz as keyof typeof VIZ_META];
  if (!v || s.dims.length < v.minDims || s.dims.length > v.maxDims) return false;
  if (s.viz === "funnel" && s.dims[0] !== "stage") return false; // 漏斗图只能按阶段
  if (s.viz === "line" && s.dims[0] !== "date") return false;    // 折线 X 必须是日期
  if (m.needsStage && !s.dims.includes("stage") && !s.params?.stage) return false;
  if (m.needsCvr && (!s.params?.cvrFrom || !s.params?.cvrTo)) return false;
  return true;
}

// POST /api/ai/suggest { dashboardId } → { suggestions:[{title,measure,params?,dims,viz,reason}] }
export async function POST(req: Request) {
  try {
    if (!kimiConfigured()) return NextResponse.json({ error: "AI 未配置（缺 KIMI_API_KEY）" }, { status: 503 });
    const { dashboardId } = await req.json();
    if (!dashboardId) return NextResponse.json({ error: "dashboardId 必填" }, { status: 400 });

    const ctx = await buildBoardContext(Number(dashboardId));
    if (!ctx) return NextResponse.json({ error: "看板不存在" }, { status: 404 });

    const catalog = MEASURES.map((m) => `${m.key}(${m.label}, 立方体=${m.cube}, 可用维度=[${m.allowedDims.join(",")}]${m.needsStage ? ", 需params.stage" : ""}${m.needsCvr ? ", 需params.cvrFrom/cvrTo" : ""})`).join("\n");
    const vizList = Object.entries(VIZ_META).map(([k, v]) => `${k}(维度${v.minDims}-${v.maxDims})`).join(", ");
    const system =
      "你是广告数据看板顾问。基于当前看板已有卡片与数据，推荐 3-5 张能补充洞察的新卡片。" +
      "只能用给定度量目录里的 measure 和其 allowedDims 内的维度；viz 的维度数量要匹配。" +
      "严格返回 JSON：{\"suggestions\":[{\"title\":\"中文标题\",\"measure\":\"key\",\"params\":{\"stage\":\"stage_key\"},\"dims\":[\"date\"],\"viz\":\"line\",\"reason\":\"为什么建议\"}]}。" +
      "params 仅在度量需要时给。不要推荐已有的重复卡片。";
    const user =
      `度量目录：\n${catalog}\n\n图表类型：${vizList}\n\n${contextToText(ctx)}\n\n请返回 JSON 建议。`;

    // 用 moonshot-v1-32k（非思考模型，快 + 稳定 JSON），避免 kimi-k2.x 思考模型的高延迟。
    const raw = await kimiChat([{ role: "system", content: system }, { role: "user", content: user }], {
      model: "moonshot-v1-32k",
      temperature: 0.4,
      json: true,
      maxTokens: 1500,
    });
    let parsed: { suggestions?: Suggestion[] };
    try {
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      parsed = start >= 0 && end > start ? JSON.parse(raw.slice(start, end + 1)) : {};
    } catch {
      return NextResponse.json({ suggestions: [], note: "AI 返回解析失败" });
    }
    const list = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
    const suggestions = list.filter(validate).slice(0, 5);
    return NextResponse.json({ suggestions });
  } catch (e: unknown) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
