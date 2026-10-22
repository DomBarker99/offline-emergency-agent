/**
 * Minimal chat client using plain `fetch`, with no Agents SDK.
 *
 * Used only by the smoke test (smoke.ts) to check that a provider is reachable and answering.
 * If the agent misbehaves, run the smoke test first: if this works but the agent doesn't, the
 * problem is in our agent code; if this fails too, it's the provider, URL or key.
 *
 * Both providers implement the OpenAI Chat Completions API:
 *   POST <baseUrl>/chat/completions  { model, messages, max_tokens, ... }
 */
import type { ResolvedModel } from "../core/config.ts";

/** One chat message in the OpenAI format. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** What the smoke test prints. */
export interface ChatResult {
  text: string;
  /** Length of any hidden reasoning the model produced (0 = reasoning was off). */
  reasoningChars: number;
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
  /** Model ID reported back by the provider (confirms which model actually answered). */
  servedBy?: string;
}

/**
 * Sends one chat request and returns the reply plus basic stats.
 * @throws on a missing API key or any non-2xx HTTP response
 */
export async function chat(model: ResolvedModel, messages: ChatMessage[], maxTokens = 400): Promise<ChatResult> {
  if (model.provider !== "local" && !model.apiKey) {
    throw new Error(`No API key for ${model.provider}. Set it in .env (see .env.example).`);
  }

  // Request headers. The key goes in the standard "Authorization: Bearer ..." header.
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (model.apiKey) headers.Authorization = `Bearer ${model.apiKey}`;
  // OpenRouter shows this name in its usage dashboard.
  if (model.provider === "openrouter") headers["X-Title"] = "offline-emergency-agent (dev)";

  const started = performance.now();
  const res = await fetch(`${model.baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: model.modelId,
      messages,
      max_tokens: maxTokens,
      temperature: 0.2,
      ...model.extraRequest, // provider-specific extras from config/models.json
    }),
  });
  const latencyMs = Math.round(performance.now() - started);

  if (!res.ok) {
    // Show the provider's error message. Never print the request headers: they contain the key.
    throw new Error(`${model.provider} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  // Response format: { choices: [{ message: { content, reasoning_content? } }], usage: {...}, model }
  // `any` because providers add their own extra fields; we only read the common ones.
  const data = (await res.json()) as any;
  const msg = data.choices?.[0]?.message ?? {};

  return {
    text: (msg.content ?? "").trim(),
    // Providers name the reasoning field differently (llama.cpp: reasoning_content, OpenRouter: reasoning).
    reasoningChars: (msg.reasoning_content ?? msg.reasoning ?? "").length,
    latencyMs,
    promptTokens: data.usage?.prompt_tokens,
    completionTokens: data.usage?.completion_tokens,
    servedBy: data.model,
  };
}
