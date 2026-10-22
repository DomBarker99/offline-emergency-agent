// Smoke test: send the same grounded emergency question to each provider and print the result.
// Usage: npm run smoke [-- <provider> [logicalModel]]   e.g. npm run smoke:local, npm run smoke:openrouter
import { resolveModel, type ProviderName } from "../core/config.ts";
import { chat, type ChatMessage } from "./raw-client.ts";

const SYSTEM =
  "You are an offline emergency assistant. Answer ONLY from the provided cards and cite card IDs like [C1]. " +
  "If the cards do not contain the answer, say exactly 'That is not in your emergency pack.' Be brief.";

const MESSAGES: ChatMessage[] = [
  { role: "system", content: SYSTEM },
  {
    role: "user",
    content:
      "Cards:\n[C4] POWER OUTAGE: Never run a generator, grill or camp stove indoors or in a garage: carbon monoxide can kill.\n\n" +
      "Question: Can I run our generator in the garage if I leave the door open?",
  },
];

const [providerArg, modelArg] = process.argv.slice(2);
const providers: ProviderName[] = providerArg ? [providerArg as ProviderName] : ["local", "openrouter"];

let failures = 0;
for (const provider of providers) {
  try {
    const model = resolveModel(provider, modelArg);
    const r = await chat(model, MESSAGES);
    console.log(`\n[${provider}] ${model.logicalName} -> ${model.modelId} (served by ${r.servedBy ?? "?"})`);
    console.log(`  ${r.latencyMs} ms, ${r.completionTokens ?? "?"} tokens, reasoning chars: ${r.reasoningChars}`);
    console.log(`  ${r.text.replace(/\n/g, "\n  ")}`);
  } catch (err) {
    failures++;
    console.error(`\n[${provider}] FAILED: ${(err as Error).message}`);
  }
}
process.exitCode = failures ? 1 : 0;
