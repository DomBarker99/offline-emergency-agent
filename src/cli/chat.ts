/**
 * Terminal chat for development and testing.
 *
 * Calls the agent core (`ask()` in src/core/agent.ts) directly, in the same process.
 * No HTTP server is involved.
 *
 * Usage:
 *   npm run chat
 *   npm run chat -- --provider openrouter
 *   npm run chat -- --model granite-8b
 *   (the "--" passes the flags through npm to this script)
 *
 * Commands inside the chat:
 *   /cards              show which cards the last answer used (* = pinned by the safety router)
 *   /situation <text>   add a note to the current situation, e.g. "/situation power out since 6pm"
 *   /model <name>       switch logical model (see config/models.json)
 *   /provider <name>    switch provider: local | openrouter
 *   /clear              forget the conversation and situation
 *   /quit               exit
 *
 * Works interactively and with piped input, e.g.:
 *   printf 'Can I use the grill indoors?\n/quit\n' | npm run chat
 */
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { readFileSync } from "node:fs";
import { ask } from "../core/agent.ts";
import { logDir } from "../core/audit.ts";
import { loadModels, type ProviderName } from "../core/config.ts";
import { loadDemoStore } from "../core/knowledge.ts";
import type { AskResponse, Profile, Situation, Turn } from "../core/types.ts";

// ---------------------------------------------------------------------------
// Startup: read flags, load cards and profile
// ---------------------------------------------------------------------------

/** Returns the value after a flag, e.g. argValue("--model") for `--model granite-8b`. */
const args = process.argv.slice(2);
function argValue(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

let provider = (argValue("--provider") ?? "local") as ProviderName;
let model = argValue("--model") ?? loadModels().defaultModel;

const store = loadDemoStore();
const profile = JSON.parse(
  readFileSync(new URL("../../data/demo/profile.json", import.meta.url), "utf8"),
) as Profile;

// Chat state, kept in memory for this session only.
const history: Turn[] = []; // conversation memory, sent with every question
const situation: Situation = { notes: [] }; // situation memory, built with /situation
let last: AskResponse | undefined; // most recent answer, for /cards

console.log(
  `Offline emergency agent (dev chat). provider=${provider} model=${model}. ` +
    `Demo cards: ${store.all().length}. Logs: ${logDir()}`,
);
console.log("Commands: /model <name> /provider <local|openrouter> /cards /situation <text> /clear /quit\n");

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Handles a line starting with "/".
 * @returns "quit" to exit the chat, otherwise "continue"
 */
function handleCommand(line: string): "quit" | "continue" {
  const [command, ...rest] = line.split(" ");
  const value = rest.join(" ").trim();

  switch (command) {
    case "/quit":
      return "quit";

    case "/clear":
      history.length = 0; // empties the array in place
      situation.notes = [];
      console.log("(conversation cleared)");
      break;

    case "/model":
      model = value;
      console.log(`(model = ${model})`);
      break;

    case "/provider":
      provider = value as ProviderName;
      console.log(`(provider = ${provider})`);
      break;

    case "/situation":
      situation.notes.push(value);
      console.log(`(situation: ${situation.notes.join("; ")})`);
      break;

    case "/cards":
      for (const card of last?.cards ?? []) {
        console.log(`  [${card.id}]${card.pinned ? " (pinned)" : ""} ${card.title} | ${card.source.name}`);
      }
      break;

    default:
      console.log(`(unknown command: ${command})`);
  }
  return "continue";
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

/** Sends one question to the agent, prints the answer plus a one-line summary, updates history. */
async function handleQuestion(question: string): Promise<void> {
  try {
    last = await ask({ question, history, situation, provider, model }, { store, profile });

    console.log(`\nagent> ${last.answer}\n`);

    // Summary line: model, time, cards used (* = pinned), danger matches, flags.
    const summary = [
      last.model.id,
      `${(last.timingsMs.total / 1000).toFixed(1)}s`,
      `cards ${last.cards.map((c) => c.id + (c.pinned ? "*" : "")).join(",")}`,
    ];
    if (last.dangers.length) summary.push(`danger: ${last.dangers.join(",")}`);
    if (last.flags.length) summary.push(`FLAGS: ${last.flags.join(", ")}`);
    console.log(`  (${summary.join(" | ")})\n`);

    // Remember the exchange so follow-up questions have context.
    history.push({ role: "user", text: question }, { role: "assistant", text: last.answer });
  } catch (err) {
    // Configuration or network problems: report and keep the chat running.
    console.error(`  error: ${(err as Error).message}\n`);
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

const rl = createInterface({ input: stdin, output: stdout });

// With piped input, readline closes as soon as the input ends, possibly while an answer is
// still being generated. Track that, so we don't try to show a prompt on a closed interface.
let inputClosed = false;
rl.on("close", () => {
  inputClosed = true;
});
function prompt(): void {
  if (!inputClosed) rl.prompt();
}

rl.setPrompt("you> ");
prompt();

// `for await` reads one line at a time and waits for each answer before reading the next.
for await (const raw of rl) {
  const line = raw.trim();

  // When input is piped, echo it so the transcript shows what was asked.
  if (!stdin.isTTY && line) console.log(line);

  if (line.startsWith("/")) {
    if (handleCommand(line) === "quit") break;
  } else if (line) {
    await handleQuestion(line);
  }
  prompt();
}
rl.close();
