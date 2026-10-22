// Minimal OpenAI-compatible chat client using plain fetch.
// TEMPORARY: proves both providers work before an agent SDK is chosen. Both OpenRouter and
// llama-server speak the same /v1/chat/completions API, so one client covers local and cloud.
import type { ResolvedModel } from "../core/config.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  text: string;
  reasoningChars: number;
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
  servedBy?: string; // provider-reported model id
}

export async function chat(model: ResolvedModel, messages: ChatMessage[], maxTokens = 400): Promise<ChatResult> {
  if (model.provider !== "local" && !model.apiKey) {
    throw new Error(`No API key for ${model.provider}. Set it in .env (see .env.example).`);
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (model.apiKey) headers.Authorization = `Bearer ${model.apiKey}`;
  if (model.provider === "openrouter") headers["X-Title"] = "offline-emergency-agent (dev)";

  const started = performance.now();
  const res = await fetch(`${model.baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: model.modelId, messages, max_tokens: maxTokens, temperature: 0.2, ...model.extraRequest }),
  });
  const latencyMs = Math.round(performance.now() - started);
  if (!res.ok) {
    // Never echo request headers (they contain the key); the body is the provider's error message.
    throw new Error(`${model.provider} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as any;
  const msg = data.choices?.[0]?.message ?? {};
  return {
    text: (msg.content ?? "").trim(),
    reasoningChars: (msg.reasoning_content ?? msg.reasoning ?? "").length,
    latencyMs,
    promptTokens: data.usage?.prompt_tokens,
    completionTokens: data.usage?.completion_tokens,
    servedBy: data.model,
  };
}
