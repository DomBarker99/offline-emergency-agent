/**
 * Connects the OpenAI Agents SDK to whichever provider config/models.json points at.
 * Used by step 4 of the request flow (see agent.ts).
 *
 * BACKGROUND: TWO SDK CONCEPTS
 *  - `Agent`: what to say and how (instructions, model name, guardrails). Built in agent.ts.
 *  - `Runner`: actually executes an Agent. Each Runner has a "model provider" that knows
 *    how to reach a model by name.
 *
 * By default the SDK talks to OpenAI. Here we give the Runner an `OpenAIProvider` pointed at
 * a different base URL. Both our providers (a local llama.cpp server and OpenRouter) implement
 * the same OpenAI "Chat Completions" API, so one provider class covers both. Only the URL,
 * key and model name differ, and those come from config.
 */
import { OpenAIProvider, Runner } from "@openai/agents";
import { resolveModel, type ProviderName, type ResolvedModel } from "./config.ts";

/** A ready-to-use Runner plus the model details it was configured with. */
export interface ModelHandle {
  runner: Runner;
  model: ResolvedModel;
}

/**
 * Creates a Runner for one provider and logical model.
 *
 * @param provider     "local" or "openrouter"
 * @param logicalName  e.g. "granite-8b"; defaults to the config's defaultModel
 * @throws if a cloud provider is chosen but its API key isn't set
 */
export function createModelHandle(provider: ProviderName, logicalName?: string): ModelHandle {
  const model = resolveModel(provider, logicalName);

  // Fail early with a helpful message instead of an opaque 401 from the provider.
  if (provider !== "local" && !model.apiKey) {
    throw new Error(`No API key for ${provider}. Set it in .env (see .env.example).`);
  }

  const modelProvider = new OpenAIProvider({
    baseURL: model.baseUrl,
    // The OpenAI client library requires some key. A local server ignores it, so any placeholder works.
    apiKey: model.apiKey ?? "local-no-key",
    // false = use the Chat Completions API (what local servers and OpenRouter implement),
    // rather than OpenAI's newer Responses API (which they generally don't).
    useResponses: false,
  });

  return { runner: new Runner({ modelProvider }), model };
}
