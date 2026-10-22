/**
 * Smoke test: is each provider reachable, and does the model give a grounded answer?
 *
 * Sends one fixed question (with one card) straight to the provider using the plain fetch
 * client (raw-client.ts), bypassing the Agents SDK and the rest of the agent. Use it to rule
 * out connection, URL or API-key problems before debugging agent code.
 *
 * Usage:
 *   npm run smoke                      both providers, default model
 *   npm run smoke:local                local provider only
 *   npm run smoke:openrouter           OpenRouter only
 *   npm run smoke -- local granite-8b  specific provider + logical model
 *
 * Exit code is 1 if any provider failed (handy in scripts).
 */
import { resolveModel, type ProviderName } from "../core/config.ts";
import { chat, type ChatMessage } from "./raw-client.ts";

// A short version of the real rules (the full ones are in src/core/prompt.ts).
const SYSTEM =
  "You are an offline emergency assistant. Answer ONLY from the provided cards and cite card IDs like [C1]. " +
  "If the cards do not contain the answer, say exactly 'That is not in your emergency pack.' Be brief.";

// One card and one question. A good answer says "no" and cites [C4].
const MESSAGES: ChatMessage[] = [
  { role: "system", content: SYSTEM },
  {
    role: "user",
    content:
      "Cards:\n[C4] POWER OUTAGE: Never run a generator, grill or camp stove indoors or in a garage: carbon monoxide can kill.\n\n" +
      "Question: Can I run our generator in the garage if I leave the door open?",
  },
];

// Optional arguments: [provider] [logicalModel]
const [providerArg, modelArg] = process.argv.slice(2);
const providers: ProviderName[] = providerArg ? [providerArg as ProviderName] : ["local", "openrouter"];

let failures = 0;
for (const provider of providers) {
  try {
    const model = resolveModel(provider, modelArg);
    const result = await chat(model, MESSAGES);

    console.log(`\n[${provider}] ${model.logicalName} -> ${model.modelId} (served by ${result.servedBy ?? "?"})`);
    console.log(`  ${result.latencyMs} ms, ${result.completionTokens ?? "?"} tokens, reasoning chars: ${result.reasoningChars}`);
    console.log(`  ${result.text.replace(/\n/g, "\n  ")}`); // indent multi-line answers
  } catch (err) {
    failures++;
    console.error(`\n[${provider}] FAILED: ${(err as Error).message}`);
  }
}

// Setting exitCode (instead of calling process.exit) lets pending output finish printing.
process.exitCode = failures ? 1 : 0;
