/**
 * Model configuration: turns a logical model name into a concrete endpoint.
 *
 * WHY THIS EXISTS
 * The rest of the code never mentions a specific model or provider URL. It asks for
 * something like ("local", "gemma-26b") and this file looks up, in config/models.json:
 *   - which base URL to call (local model server or OpenRouter),
 *   - which API key to send (read from an environment variable, never from a file in git),
 *   - the provider's own name for that model (e.g. "google/gemma-4-26b-a4b-it"),
 *   - any extra request fields that provider needs for that model.
 *
 * To add or swap a model, edit config/models.json. No code changes needed.
 */
import { readFileSync } from "node:fs";

/** The providers we know how to talk to. Both speak the OpenAI Chat Completions API. */
export type ProviderName = "local" | "openrouter";

// ---------------------------------------------------------------------------
// Shapes of config/models.json (see that file for a live example)
// ---------------------------------------------------------------------------

/** How to reach one provider. */
interface ProviderConfig {
  /** Root of the OpenAI-compatible API, e.g. "http://127.0.0.1:8080/v1". */
  baseUrl: string;
  /** Name of the environment variable holding the API key, or null if none is needed (local). */
  apiKeyEnv: string | null;
}

/** How one logical model maps onto one provider. */
interface ModelBinding {
  /** The provider's own model ID. */
  id: string;
  /** Extra JSON fields merged into each request (e.g. OpenRouter's `reasoning` switch). */
  request?: Record<string, unknown>;
}

/** The whole config file. */
interface ModelsFile {
  providers: Record<ProviderName, ProviderConfig>;
  /** Logical model used when the caller doesn't name one. */
  defaultModel: string;
  /** logical name -> per-provider binding. A model may exist on only some providers. */
  models: Record<string, Partial<Record<ProviderName, ModelBinding>>>;
}

/** Everything needed to call one model on one provider. Returned by resolveModel(). */
export interface ResolvedModel {
  logicalName: string; // e.g. "gemma-26b"
  provider: ProviderName; // e.g. "openrouter"
  baseUrl: string; // after applying any environment override
  apiKey: string | undefined; // undefined for providers that don't need one
  modelId: string; // provider's ID, e.g. "google/gemma-4-26b-a4b-it"
  extraRequest: Record<string, unknown>; // extra request fields ({} if none)
}

// `import.meta.url` is the URL of THIS file, so the path below resolves to
// <repo>/config/models.json no matter which directory the process was started from.
const CONFIG_URL = new URL("../../config/models.json", import.meta.url);

/**
 * Reads config/models.json from disk.
 * Read on every call (not cached) so edits take effect without restarting a long-running server.
 */
export function loadModels(): ModelsFile {
  return JSON.parse(readFileSync(CONFIG_URL, "utf8")) as ModelsFile;
}

/**
 * Looks up a logical model on a provider.
 *
 * @param provider     "local" or "openrouter"
 * @param logicalName  e.g. "gemma-26b"; falls back to `defaultModel` when omitted
 * @throws if the provider is unknown or the model has no binding for that provider
 */
export function resolveModel(provider: ProviderName, logicalName?: string): ResolvedModel {
  const cfg = loadModels();
  const name = logicalName ?? cfg.defaultModel;

  const providerCfg = cfg.providers[provider];
  if (!providerCfg) {
    throw new Error(`Unknown provider "${provider}" (see config/models.json)`);
  }

  // `?.` (optional chaining): if the model name doesn't exist at all, this yields
  // undefined instead of crashing, and we report a clear error below.
  const binding = cfg.models[name]?.[provider];
  if (!binding) {
    throw new Error(`Model "${name}" has no "${provider}" binding in config/models.json`);
  }

  // The base URL can be overridden per machine with an environment variable
  // (LOCAL_BASE_URL / OPENROUTER_BASE_URL), e.g. if the local server runs on another port.
  const baseUrl = process.env[`${provider.toUpperCase()}_BASE_URL`] ?? providerCfg.baseUrl;

  // The key itself lives in the environment (loaded from .env by the npm scripts).
  const apiKey = providerCfg.apiKeyEnv ? process.env[providerCfg.apiKeyEnv] : undefined;

  return {
    logicalName: name,
    provider,
    baseUrl,
    apiKey,
    modelId: binding.id,
    extraRequest: binding.request ?? {},
  };
}
