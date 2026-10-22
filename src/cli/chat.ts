// Terminal chat: calls the core directly, in the same process (no server needed).
// Usage: npm run chat [-- --provider openrouter] [-- --model granite-8b]
// Commands: /model <name>  /provider <local|openrouter>  /cards  /situation <text>  /clear  /quit
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { readFileSync } from "node:fs";
import { ask } from "../core/agent.ts";
import { logDir } from "../core/audit.ts";
import { loadModels, type ProviderName } from "../core/config.ts";
import { loadDemoStore } from "../core/knowledge.ts";
import type { AskResponse, Profile, Situation, Turn } from "../core/types.ts";

const args = process.argv.slice(2);
const argValue = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
let provider = (argValue("--provider") ?? "local") as ProviderName;
let model = argValue("--model") ?? loadModels().defaultModel;

const store = loadDemoStore();
const profile = JSON.parse(readFileSync(new URL("../../data/demo/profile.json", import.meta.url), "utf8")) as Profile;
const history: Turn[] = [];
const situation: Situation = { notes: [] };
let last: AskResponse | undefined;

const rl = createInterface({ input: stdin, output: stdout });
console.log(`Offline emergency agent (dev chat). provider=${provider} model=${model}. Demo cards: ${store.all().length}. Logs: ${logDir()}`);
console.log("Commands: /model <name> /provider <local|openrouter> /cards /situation <text> /clear /quit\n");

let inputClosed = false;
rl.on("close", () => { inputClosed = true; }); // piped input ends before answers finish
const prompt = () => { if (!inputClosed) rl.prompt(); };
rl.setPrompt("you> ");
prompt();
for await (const raw of rl) {
  const line = raw.trim();
  if (!stdin.isTTY && line) console.log(line); // echo piped input so transcripts read naturally
  if (!line) { prompt(); continue; }
  if (line === "/quit") break;
  if (line === "/clear") { history.length = 0; situation.notes = []; console.log("(conversation cleared)"); prompt(); continue; }
  if (line.startsWith("/model ")) { model = line.slice(7).trim(); console.log(`(model = ${model})`); prompt(); continue; }
  if (line.startsWith("/provider ")) { provider = line.slice(10).trim() as ProviderName; console.log(`(provider = ${provider})`); prompt(); continue; }
  if (line.startsWith("/situation ")) { situation.notes.push(line.slice(11).trim()); console.log(`(situation: ${situation.notes.join("; ")})`); prompt(); continue; }
  if (line === "/cards") {
    for (const c of last?.cards ?? []) console.log(`  [${c.id}]${c.pinned ? " (pinned)" : ""} ${c.title} | ${c.source.name}`);
    prompt();
    continue;
  }
  try {
    last = await ask({ question: line, history, situation, provider, model }, { store, profile });
    console.log(`\nagent> ${last.answer}\n`);
    const meta = [`${last.model.id}`, `${(last.timingsMs.total / 1000).toFixed(1)}s`, `cards ${last.cards.map((c) => c.id + (c.pinned ? "*" : "")).join(",")}`];
    if (last.dangers.length) meta.push(`danger: ${last.dangers.join(",")}`);
    if (last.flags.length) meta.push(`FLAGS: ${last.flags.join(", ")}`);
    console.log(`  (${meta.join(" | ")})\n`);
    history.push({ role: "user", text: line }, { role: "assistant", text: last.answer });
  } catch (err) {
    console.error(`  error: ${(err as Error).message}\n`);
  }
  prompt();
}
rl.close();
