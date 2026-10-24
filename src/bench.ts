/**
 * Benchmark on the questions in data/eval/questions.json.
 *
 * Usage:  npm run bench -- --provider openrouter        (or local)
 *         npm run bench -- --retrieval-only             (search only, no model, a few seconds)
 *
 * Measures, per question: did search put a known-good source page in the top 5 ("gold"), did the answer
 * cite it, does the answer contain an expected key fact, did the agent decline questions the library
 * can't answer, did the right danger rule fire, any flags, time. Results: logs/bench/<time>.json
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { ask, searchText, type ProviderName, type Turn } from "./agent.ts";
import { loadLibrary } from "./search.ts";

interface Question {
  id: string;
  type: "answerable" | "followup" | "out-of-scope";
  question: string;
  history?: Turn[];
  gold: string[]; // URL patterns of pages that contain the answer
  expectAny?: string[]; // phrases a good answer usually contains
  danger?: string; // danger rule that should fire
}
const questions: Question[] = JSON.parse(readFileSync(new URL("../data/eval/questions.json", import.meta.url), "utf8")).questions;
const isGold = (q: Question, url?: string) => !!url && q.gold.some((g) => new RegExp(g, "i").test(url));
const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "n/a");
const flag = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);

// Retrieval: no model involved.
const library = await loadLibrary();
const withGold = questions.filter((q) => q.gold.length);
let first = 0;
let top5 = 0;
for (const q of withGold) {
  const urls = (await library.search(searchText(q.question, q.history ?? []), 5)).map((p) => p.url);
  const rank = urls.findIndex((u) => isGold(q, u));
  if (rank === 0) first++;
  if (rank >= 0) top5++;
}
console.log(`Retrieval (${withGold.length} questions): right source 1st ${pct(first, withGold.length)}, in top 5 ${pct(top5, withGold.length)}`);
if (process.argv.includes("--retrieval-only")) process.exit(0);

// Agent, end to end.
const provider = (flag("--provider") ?? "openrouter") as ProviderName;
interface Row {
  id: string;
  type: Question["type"];
  goldShown: boolean;
  goldCited: boolean;
  expectHit: boolean;
  declined: boolean;
  dangerOk: boolean | null;
  flags: string[];
  ms: number;
  answer: string;
}
const rows: Row[] = [];
for (const q of questions) {
  const t = await ask(q.question, q.history ?? [], provider, flag("--model"));
  const cited = new Set([...t.answer.matchAll(/\[([A-Z]+\d+)\]/g)].map((m) => m[1]));
  const row: Row = {
    id: q.id,
    type: q.type,
    goldShown: t.sources.some((s) => isGold(q, s.url)),
    goldCited: t.sources.some((s) => cited.has(s.id) && isGold(q, s.url)),
    expectHit: (q.expectAny ?? []).some((e) => t.answer.toLowerCase().includes(e.toLowerCase())),
    declined: /not in your emergency pack/i.test(t.answer),
    dangerOk: q.danger ? t.dangers.includes(q.danger) : null,
    flags: t.flags,
    ms: t.ms.total,
    answer: t.answer,
  };
  rows.push(row);
  console.log(`${q.id.padEnd(18)} ${row.goldCited ? "cited-gold" : row.goldShown ? "gold-shown" : row.declined ? "declined" : "no-gold"} ${t.flags.join(",")} ${t.ms.total}ms`);
}
const inScope = rows.filter((r) => r.type !== "out-of-scope");
const oos = rows.filter((r) => r.type === "out-of-scope");
const dangerRows = rows.filter((r) => r.dangerOk !== null);
const count = (rs: Row[], f: "goldShown" | "goldCited" | "expectHit" | "declined" | "dangerOk") => rs.filter((r) => r[f] === true).length;
const summary = [
  `Agent (${provider}, ${rows.length} questions)`,
  `  right source shown (answerable)     ${pct(count(inScope, "goldShown"), inScope.length)}`,
  `  right source cited (answerable)     ${pct(count(inScope, "goldCited"), inScope.length)}`,
  `  expected key fact in answer         ${pct(count(inScope, "expectHit"), inScope.length)}`,
  `  wrongly said "not in your pack"     ${pct(count(inScope, "declined"), inScope.length)}`,
  `  out-of-scope correctly declined     ${pct(count(oos, "declined"), oos.length)}`,
  `  danger rule fired when expected     ${pct(count(dangerRows, "dangerOk"), dangerRows.length)}`,
  `  answers with any flag               ${pct(rows.filter((r) => r.flags.length).length, rows.length)}`,
  `  average time per answer             ${Math.round(rows.reduce((s, r) => s + r.ms, 0) / rows.length)} ms`,
].join("\n");
console.log(`\n${summary}`);
mkdirSync(new URL("../logs/bench/", import.meta.url), { recursive: true });
const out = new URL(`../logs/bench/${new Date().toISOString().replace(/[:.]/g, "-")}-${provider}.json`, import.meta.url);
writeFileSync(out, JSON.stringify({ summary, rows }, null, 2));
console.log(`\nDetails: ${out.pathname}`);
