// Connects the OpenAI Agents SDK to whichever provider config/models.json points at.
// Both llama-server (local) and OpenRouter speak the Chat Completions API, so one
// OpenAIProvider with a different baseURL covers both. No model-specific code here.
import { OpenAIProvider, Runner } from "@openai/agents";
import { resolveModel, type ProviderName, type ResolvedModel } from "./config.ts";

export interface ModelHandle {
  runner: Runner;
  model: ResolvedModel;
}

export function createModelHandle(provider: ProviderName, logicalName?: string): ModelHandle {
  const model = resolveModel(provider, logicalName);
  if (provider !== "local" && !model.apiKey) {
    throw new Error(`No API key for ${provider}. Set it in .env (see .env.example).`);
  }
  const modelProvider = new OpenAIProvider({
    baseURL: model.baseUrl,
    apiKey: model.apiKey ?? "local-no-key", // llama-server ignores the key; the client requires a value
    useResponses: false, // Chat Completions: the API both llama-server and OpenRouter implement
  });
  return { runner: new Runner({ modelProvider }), model };
}
