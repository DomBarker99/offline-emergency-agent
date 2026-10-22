// Loads config/models.json and resolves a logical model name to a concrete provider endpoint.
// Model-agnostic by design: callers ask for ("gemma-26b", "local"); everything provider-
// or model-specific comes from config, never from application code.
import { readFileSync } from "node:fs";

export type ProviderName = "local" | "openrouter";

interface ProviderConfig {
  baseUrl: string;
  apiKeyEnv: string | null;
}

interface ModelBinding {
  id: string;
  request?: Record<string, unknown>;
}

interface ModelsFile {
  providers: Record<ProviderName, ProviderConfig>;
  defaultModel: string;
  models: Record<string, Partial<Record<ProviderName, ModelBinding>>>;
}

export interface ResolvedModel {
  logicalName: string;
  provider: ProviderName;
  baseUrl: string;
  apiKey: string | undefined;
  modelId: string;
  extraRequest: Record<string, unknown>;
}

const CONFIG_URL = new URL("../../config/models.json", import.meta.url);

export function loadModels(): ModelsFile {
  return JSON.parse(readFileSync(CONFIG_URL, "utf8")) as ModelsFile;
}

export function resolveModel(provider: ProviderName, logicalName?: string): ResolvedModel {
  const cfg = loadModels();
  const name = logicalName ?? cfg.defaultModel;
  const providerCfg = cfg.providers[provider];
  if (!providerCfg) throw new Error(`Unknown provider "${provider}" (see config/models.json)`);
  const binding = cfg.models[name]?.[provider];
  if (!binding) throw new Error(`Model "${name}" has no "${provider}" binding in config/models.json`);
  // Base URL may be overridden per machine without editing the repo (e.g. a different port).
  const baseUrl = process.env[`${provider.toUpperCase()}_BASE_URL`] ?? providerCfg.baseUrl;
  const apiKey = providerCfg.apiKeyEnv ? process.env[providerCfg.apiKeyEnv] : undefined;
  return { logicalName: name, provider, baseUrl, apiKey, modelId: binding.id, extraRequest: binding.request ?? {} };
}
