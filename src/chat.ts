/**
 * Terminal chat. Type a question, get a cited answer. Remembers the conversation until /clear.
 *
 * Usage:   npm run chat                                 (provider from AGENT_PROVIDER in .env, default local)
 *          npm run chat -- --provider openrouter        (Gemma on OpenRouter, needs internet)
 *          npm run chat -- --provider local             (Gemma on this laptop; run playground/start.sh first)
 *          add  --model <name>  to use another model on that provider
 * Shows only the answer (citation tags removed). Commands: /sources (what the last answer was based on,
 * for debugging)  /clear  /quit. Everything else is in logs/turns-<date>.jsonl.
 * Piped input works too:  printf 'Can I use the grill indoors?\n' | npm run chat -- --provider local
 */
import { createInterface } from "node:readline";
import { ask, PROVIDERS, stripCitations, type ProviderName, type Turn } from "./agent.ts";

const flag = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const provider = (flag("--provider") ?? process.env.AGENT_PROVIDER ?? "local") as ProviderName;
const model = flag("--model");
if (!(provider in PROVIDERS)) throw new Error(`--provider must be one of: ${Object.keys(PROVIDERS).join(", ")}`);

const history: Turn[] = [];
let last: Awaited<ReturnType<typeof ask>> | undefined;
console.log(`Emergency agent. provider=${provider} model=${model ?? PROVIDERS[provider].model}. /sources /clear /quit\n`);

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "you> " });
// With piped input, stdin can end while an answer is still being generated; prompting after that throws.
let inputEnded = false;
rl.on("close", () => (inputEnded = true));
rl.prompt();
for await (const line of rl) {
  const text = line.trim();
  if (text === "/quit") break;
  if (text === "/clear") {
    history.length = 0;
    console.log("(conversation cleared)");
  } else if (text === "/sources") {
    for (const s of last?.sources ?? []) {
      console.log(`  [${s.id}]${s.pinned ? " (danger card)" : ""} ${s.title} | ${s.publisher}${s.ref ? ` {${s.ref}}` : ""} ${s.url ?? ""}`);
    }
  } else if (text) {
    try {
      last = await ask(text, history, provider, model);
      const answer = stripCitations(last.answer);
      console.log(`\nagent> ${answer}\n`);
      history.push({ role: "user", text }, { role: "assistant", text: answer });
    } catch (e) {
      console.log(`(error: ${(e as Error).message})`);
    }
  }
  if (!inputEnded) rl.prompt();
}
rl.close();
