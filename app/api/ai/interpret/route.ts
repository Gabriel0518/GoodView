import { NextResponse } from "next/server";
import { kimiChat, kimiConfigured } from "../../../lib/kimi";
import { buildBoardContext, contextToText } from "../../../lib/ai-context";

export const dynamic = "force-dynamic";

// POST /api/ai/interpret { dashboardId } → { text } —— 读整看板卡片数据，Kimi 生成中文洞察。
export async function POST(req: Request) {
  try {
    if (!kimiConfigured()) return NextResponse.json({ error: "AI 未配置（缺 KIMI_API_KEY）" }, { status: 503 });
    const { dashboardId } = await req.json();
    if (!dashboardId) return NextResponse.json({ error: "dashboardId 必填" }, { status: 400 });

    const ctx = await buildBoardContext(Number(dashboardId));
    if (!ctx) return NextResponse.json({ error: "看板不存在" }, { status: 404 });
    if (!ctx.cards.length) return NextResponse.json({ text: "这个看板还没有卡片，先添加卡片再生成解读。" });

    const system =
      "你是资深广告投放数据分析师。基于给定看板的卡片聚合数据，用简洁中文给出洞察，聚焦：整体趋势、异常波动、成本效率恶化的渠道/来源/系列、单位转化成本变化、值得关注的风险。" +
      "重要口径：比值(CPM/CTR/转化率/单位成本)不可简单相加；人数为『人次』(日UV之和，非周期去重)；跨立方(单位成本)仅 fb/tt 有渠道↔来源映射。" +
      "不要编造数据里没有的数字。用 3-6 条要点 + 一句总结，可用简单 markdown。";
    const text = await kimiChat(
      [
        { role: "system", content: system },
        { role: "user", content: contextToText(ctx) + "\n\n请给出解读。" },
      ],
    );
    return NextResponse.json({ text });
  } catch (e: unknown) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
