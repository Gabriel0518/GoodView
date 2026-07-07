// Kimi (Moonshot) 客户端 —— OpenAI 兼容 /chat/completions。
// 配置读环境变量：KIMI_API_KEY / KIMI_MODEL / KIMI_BASE_URL（.env）。
const KEY = process.env.KIMI_API_KEY || "";
const MODEL = process.env.KIMI_MODEL || "kimi-k2.6";
const BASE = (process.env.KIMI_BASE_URL || "https://api.moonshot.cn/v1").replace(/\/$/, "");

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export function kimiConfigured(): boolean {
  return !!KEY;
}

// 调 Kimi 聊天补全。json=true 时要求返回 JSON 对象（response_format）。
// 注：kimi-k2.x 是"思考"模型——会先产出 reasoning_content 再产出 content，且仅允许 temperature=1。
// max_tokens 同时计入 reasoning，故给足头寸（否则推理吃光额度、content 为空）。
// model 可覆盖：结构化/要快的场景用 moonshot-v1-*(非思考，支持 temperature + json_object)。
export async function kimiChat(
  messages: ChatMessage[],
  { temperature = 1, json = false, maxTokens = 6000, model }: { temperature?: number; json?: boolean; maxTokens?: number; model?: string } = {},
): Promise<string> {
  if (!KEY) throw new Error("KIMI_API_KEY 未配置");
  const body: Record<string, unknown> = {
    model: model || MODEL,
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (json) body.response_format = { type: "json_object" };

  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
    // 思考模型 + 大 max_tokens 可能较慢
    signal: AbortSignal.timeout(120000),
  });
  const j = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Kimi ${res.status}: ${(j && (j.error?.message || JSON.stringify(j))) || "无响应"}`);
  }
  const choice = j?.choices?.[0];
  const content = choice?.message?.content ?? "";
  // 思考模型可能把 max_tokens 全耗在 reasoning 上导致 content 为空（finish_reason=length）——
  // 此时静默返回 "" 会让上层把空结果当成功。显式报错，提示重试。
  if (!content.trim()) {
    throw new Error(
      choice?.finish_reason === "length"
        ? "AI 生成被截断（推理超长），请重试或精简看板"
        : "AI 未返回内容，请重试",
    );
  }
  return content;
}
