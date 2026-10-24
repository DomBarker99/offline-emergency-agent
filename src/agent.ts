/**
 * The agent: one question in, one cited answer out. Everything that happens per question is in this file.
 *
 *   ask(question)
 *     1. search text   short follow-ups ("What about the dog?") get the previous question added
 *     2. danger rules  words like "flooding" or "smell gas" force that danger's action card in
 *     3. search        the 5 library passages closest in meaning (search.ts)
 *     4. prompt        rules + household profile (system, profile.ts), then cards + passages + question (user)
 *     5. model call    OpenAI Agents SDK -> local llama-server or OpenRouter (the only AI step)
 *     6. answer check  flags missing citations, invented phone numbers or doses (never blocks)
 *     7. log           one JSON line per question in logs/turns-<date>.jsonl, including the full prompt
 *
 * Used by chat.ts (terminal) and bench.ts (benchmark).
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { Agent, assistant, OpenAIProvider, Runner, setTracingDisabled, user } from "@openai/agents";
import { profileText } from "./profile.ts";
import { loadLibrary, type Passage } from "./search.ts";

// The SDK sends traces to OpenAI by default. This app is offline and keeps its own log, so: off.
setTracingDisabled(true);

// ---- Where the model runs ---------------------------------------------------------------------
// Both speak the OpenAI Chat Completions API. Base URLs can be redirected (e.g. through mitmproxy).
export const PROVIDERS = {
  local: {
    baseURL: process.env.LOCAL_BASE_URL ?? "http://127.0.0.1:8080/v1", // llama-server from start.sh
    model: "gemma4-26b-a4b", // name from playground/models.ini
    apiKey: "not-needed",
    extra: {},
  },
  openrouter: {
    baseURL: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
    model: "google/gemma-4-26b-a4b-it",
    apiKey: process.env.OPENROUTER_API_KEY,
    extra: { reasoning: { enabled: false } }, // Gemma "thinking" off: faster, same answers
  },
};
export type ProviderName = keyof typeof PROVIDERS;

// ---- What the agent knows -------------------------------------------------------------------------
const readJson = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

/** Short action card for one danger (data/cards/library-cards.json; verbatim official sentences). */
interface Card {
  id: string;
  title: string;
  scenarios: string[];
  body: string;
  source: { name: string; url?: string };
}
const CARDS: Card[] = readJson("../data/cards/library-cards.json");
const library = await loadLibrary();

/** Danger words -> the scenario whose action card must be shown. Plain rules: same result every time. */
const DANGER_RULES: { id: string; scenario: string; pattern: RegExp }[] = [
  { id: "flood", scenario: "flood", pattern: /\b(water (is )?(rising|coming in)|flood(s|ing|ed)?|flash flood|swept away)\b/i },
  { id: "gas", scenario: "gas", pattern: /\b(smell(s|ing)? (of )?gas|gas leak|huele a gas)\b/i },
  { id: "fire", scenario: "fire", pattern: /\b((wild)?fires?|smoke|smoky|burning|incendio|humo)\b/i },
  // A fuel-burning appliance AND an enclosed place in the same sentence.
  { id: "carbon-monoxide", scenario: "power-outage", pattern: /\b(generator|grill|camp stove|carbon monoxide)\b[^.?!]*\b(inside|indoors|garage|kitchen|house)\b/i },
  { id: "earthquake", scenario: "earthquake", pattern: /\b(earthquakes?|quakes?|shaking|aftershocks?|terremoto|temblor)\b/i },
  // Named heat illness, or warning signs mentioned together with heat.
  { id: "heat", scenario: "extreme-heat", pattern: /\b(heat ?stroke|heat exhaustion|overheat(ing|ed)?|too hot|stopped sweating|golpe de calor)\b|\b(dizzy|confused|faint(ed|ing)?|hot,? (and )?dry skin)\b[^.?!]*\bheat\b|\bheat\b[^.?!]*\b(dizzy|confused|faint(ed|ing)?|hot,? (and )?dry)\b/i },
];

// ---- The system prompt ----------------------------------------------------------------------------
export const PROMPT_VERSION = "2026-10-24.3"; // bump when RULES or the profile change; it's written to the log
const RULES = [
  "You are an offline emergency assistant running on the user's laptop with no internet.",
  "Answer ONLY from the cards and official passages provided with each question",
  "Cards [C..] are short action cards. Passages [L..] are excerpts from official sources (publisher and date shown). Prefer the most specific, most recent source; if passages disagree, say so briefly. DO NOT CITE CARDS",
  "Be brief: numbered steps, at most 6.",
  "If the cards do not contain the answer, say exactly 'That is not in your emergency pack.' and suggest which official source to check when possible.",
  "Never invent phone numbers, addresses, routes or medication doses.",
  // The agent is not a clinician. It may only pass on official HANDLING guidance for medicines and devices.
  "You are not a medical provider. Never say how to treat a person, what first aid to do, what dose to give, or whether to use, keep using, ration or stop a medicine or device, even if a passage says so (for example, never say 'use it until you get a new supply'). For medicines and medical devices, repeat only handling facts from the passages: how to store them, temperature limits, how long they last unrefrigerated, when to throw them out or replace them. For any symptom, injury or treatment question, say to call 911 in an emergency, or to ask a pharmacist or doctor.",
  "Safety first: if the user describes immediate danger (rising water, fire, gas, injury), give the protective action first; a plan card about leaving when officials order it never means staying in danger.",
  "Reply in the same language the user writes in.",
];
const PROFILE_TEXT = profileText(); // data/profile.json, see profile.ts
const MEDICAL_REMINDER =
  "Reminder: for medicines and devices give handling facts only (storage, temperature, how long they last, when to replace); never whether to use or keep using them. For symptoms, injuries or treatment, refer to 911, a pharmacist or a doctor. No first aid, doses or treatment steps.";
const SYSTEM_PROMPT = [...RULES, "", PROFILE_TEXT].join("\n");

// ---- One question -----------------------------------------------------------------------------------
export interface Turn {
  role: "user" | "assistant";
  text: string;
}
const PASSAGES_PER_QUESTION = 5;

/** Step 1: a short follow-up leans on the previous question, so search with both. */
export function searchText(question: string, history: Turn[]): string {
  const previous = history.findLast((t) => t.role === "user");
  if (!previous) return question;
  const q = question.trim();
  const followUp =
    q.split(/\s+/).length <= 7 ||
    /^(and|but|what about|how about|what if|also|then|so|ok|okay|y|and if)\b/i.test(q) ||
    /\b(it|that|this|those|they|them|there)\b/i.test(q);
  return followUp ? `${previous.text} ${question}` : question;
}

/** IDs the answer cites: "[L1]", "[C1, L4]" and full-width brackets "【L2】" all count. */
export function citedIds(answer: string): string[] {
  const brackets = answer.replace(/\u3010/g, "[").replace(/\u3011/g, "]").matchAll(/\[([A-Z]+\d+(?:\s*,\s*[A-Z]+\d+)*)\]/g);
  return [...new Set([...brackets].flatMap((m) => m[1].split(/\s*,\s*/)))];
}

/**
 * The answer as people should see it: citation tags like "[L1]" or "[C4, L2]" removed.
 * The model still cites (it keeps answers tied to the sources, and the log/benchmark use the tags);
 * the chat just doesn't show them.
 */
export function stripCitations(answer: string): string {
  return answer
    .replace(/\s*[\[\u3010]\s*[A-Z]+\d+(?:\s*,\s*[A-Z]+\d+)*\s*[\]\u3011]/g, "")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .trim();
}

/** Step 6: problems in the answer, judged only against what the model was shown. Empty = fine. */
function checkAnswer(answer: string, shownIds: string[], shownText: string): string[] {
  const flags: string[] = [];
  const cited = citedIds(answer);
  if (cited.length === 0 && !/not in your emergency pack/i.test(answer)) flags.push("no-citation");
  for (const id of new Set(cited)) if (!shownIds.includes(id)) flags.push(`unknown-citation:${id}`);
  for (const m of answer.matchAll(/(\+?\d[\d\s().-]{6,}\d)|\b(911|112|999)\b/g)) {
    if (!shownText.includes(m[0].trim())) flags.push(`number-not-in-sources:${m[0].trim()}`);
  }
  const dose = /\b\d+(\.\d+)?\s*(mg|milligrams?|ml|tablets?|pills?|teaspoons?)\b/i;
  if (dose.test(answer) && !dose.test(shownText)) flags.push("dose-like-number");
  return flags;
}

/** A source shown to the model, as reported to the chat and the log. */
export interface Source {
  id: string; // what the model cites: C1..C6 for cards, L1..L5 for passages
  ref?: string; // stable passage ID behind an L number
  title: string;
  publisher: string;
  url?: string;
  pinned: boolean; // true = forced in by a danger rule
}

/**
 * Answers one question.
 * @param provider  "local" (llama-server on this laptop) or "openrouter"
 * @param model     optional model name for that provider (default: Gemma 4 26B)
 * @throws if OpenRouter is chosen without OPENROUTER_API_KEY, or the model server can't be reached
 */
export async function ask(question: string, history: Turn[], provider: ProviderName, model?: string) {
  const started = performance.now();
  const target = PROVIDERS[provider];
  if (!target.apiKey) throw new Error(`No API key for ${provider}: set OPENROUTER_API_KEY in .env`);

  const query = searchText(question, history); // 1
  const dangers = DANGER_RULES.filter((r) => r.pattern.test(query)); // 2
  const cards = CARDS.filter((c) => dangers.some((d) => c.scenarios.includes(d.scenario)));
  const passages: Passage[] = await library.search(query, PASSAGES_PER_QUESTION); // 3
  const searchMs = performance.now() - started;

  // 4: cards first, then passages with publisher and date, then the question.
  const blocks = [
    ...cards.map((c) => `[${c.id}] ${c.title.toUpperCase()}: ${c.body}`),
    ...passages.map((p, i) => {
      const title = p.heading && p.heading !== p.pageTitle ? p.heading : p.pageTitle;
      const when = p.pageDate ? `, updated ${p.pageDate}` : "";
      return `[L${i + 1}] ${title} (${p.publisher}${when}):\n${p.text}`;
    }),
  ];
  // The reminder sits right before the question because small models follow nearby instructions best.
  const message = `Cards:\n${blocks.join("\n\n") || "(no matching cards)"}\n\n${MEDICAL_REMINDER}\n\nQuestion: ${question}`;

  // 5: the Agents SDK call. Earlier turns go in as plain text; only this question gets sources.
  const runner = new Runner({
    modelProvider: new OpenAIProvider({ baseURL: target.baseURL, apiKey: target.apiKey, useResponses: false }),
  });
  const agent = new Agent({
    name: "Emergency assistant",
    instructions: SYSTEM_PROMPT,
    model: model ?? target.model,
    modelSettings: { temperature: 0.2, maxTokens: 600, providerData: target.extra },
  });
  const input = [...history.map((t) => (t.role === "user" ? user(t.text) : assistant(t.text))), user(message)];
  const result = await runner.run(agent, input);
  const answer = String(result.finalOutput ?? "").trim();

  const sources: Source[] = [
    ...cards.map((c) => ({ id: c.id, title: c.title, publisher: c.source.name, url: c.source.url, pinned: true })),
    ...passages.map((p, i) => ({ id: `L${i + 1}`, ref: p.id, title: p.heading, publisher: p.publisher, url: p.url, pinned: false })),
  ];
  // Numbers may come from the passages, the profile (e.g. the contact's phone) or the rules (911).
  const flags = checkAnswer(answer, sources.map((s) => s.id), `${message}\n${PROFILE_TEXT}\n${RULES.join("\n")}`); // 6
  const turn = {
    at: new Date().toISOString(),
    provider,
    model: model ?? target.model,
    promptVersion: PROMPT_VERSION,
    question,
    searchQuery: query,
    dangers: dangers.map((d) => d.id),
    sources,
    flags,
    answer,
    ms: { search: Math.round(searchMs), total: Math.round(performance.now() - started) },
    prompt: message,
  };
  mkdirSync(new URL("../logs/", import.meta.url), { recursive: true }); // 7
  appendFileSync(new URL(`../logs/turns-${turn.at.slice(0, 10)}.jsonl`, import.meta.url), JSON.stringify(turn) + "\n");
  return turn;
}
