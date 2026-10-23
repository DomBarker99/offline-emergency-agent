/**
 * Benchmark: how well does the agent find and use the right official guidance?
 *
 * WHERE THIS FITS
 * A development tool, not part of the request flow. It drives the same `ask()` the chat and HTTP
 * server use, with the questions in data/eval/questions.json.
 *
 * TWO PARTS
 *  1. retrieval  (no language model): for every question with known good sources ("gold"), does the
 *     search put a gold page in the top results? Compared across search methods:
 *       keyword  = today's word-overlap search (DemoKeywordStore), run over the whole library
 *       vector / lexical / graph / hybrid = the Cognee pack service's methods (knowledge/serve.py)
 *  2. agent      (end to end, with a model): ask() per question, per knowledge backend
 *     ("demo" = the 6 demo cards, "cognee" = the library). Records whether a gold source was shown
 *     and cited, whether the answer contains an expected phrase, abstentions on out-of-scope
 *     questions, grounding flags, danger detection and timings.
 *
 * USAGE (the Cognee service must be running for anything involving the library: npm run knowledge)
 *   npm run bench -- --part retrieval --passages <pack>/passages.jsonl
 *   npm run bench -- --part agent --provider openrouter --backends demo,cognee
 *   Options: --out <dir> (default logs/bench/<timestamp>)   --only <id,id>   --k 5
 *
 * OUTPUT
 *   <out>/retrieval.json, <out>/agent-<backend>-<provider>.json (one record per question)
 *   <out>/summary.md (tables), also printed to the terminal.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ask, retrievalQuery } from "../core/agent.ts";
import type { ProviderName } from "../core/config.ts";
import { DemoKeywordStore, type KnowledgeStore } from "../core/knowledge.ts";
import { passageToCard, type ServiceHit } from "../core/knowledge-cognee.ts";
import { createStore } from "../core/stores.ts";
import type { AskResponse, Profile, Turn } from "../core/types.ts";

/** One evaluation question (see data/eval/questions.json for field meanings). */
interface Question {
  id: string;
  type: "answerable" | "followup" | "out-of-scope";
  question: string;
  history?: Turn[];
  gold: string[];
  expectAny?: string[];
  danger?: string;
}

// ----- command line ---------------------------------------------------------------
const args = process.argv.slice(2);
function arg(flag: string, fallback?: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : fallback;
}
const part = arg("--part", "retrieval")!;
const k = Number(arg("--k", "5"));
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = arg("--out", join("logs", "bench", stamp))!;
const only = new Set((arg("--only", "") ?? "").split(",").filter(Boolean));
const knowledgeUrl = process.env.KNOWLEDGE_URL ?? "http://127.0.0.1:8788";

const allQuestions = (
  JSON.parse(readFileSync(new URL("../../data/eval/questions.json", import.meta.url), "utf8")) as { questions: Question[] }
).questions.filter((q) => only.size === 0 || only.has(q.id));
mkdirSync(outDir, { recursive: true });

/** True when a URL matches one of the question's gold patterns. */
function isGold(q: Question, url: string | undefined): boolean {
  return !!url && q.gold.some((g) => new RegExp(g, "i").test(url));
}

/** Percent with no decimals, for tables. */
const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "n/a");

// ----- part 1: retrieval ----------------------------------------------------------
async function benchRetrieval(): Promise<string> {
  const passagesPath = arg("--passages");
  if (!passagesPath) throw new Error("--passages <pack>/passages.jsonl is required for the keyword baseline");
  // Keyword baseline over the whole library: each passage becomes a card with its real ID.
  const passages = readFileSync(passagesPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as ServiceHit);
  const keywordStore = new DemoKeywordStore(passages.map((p) => passageToCard(p, p.id)));

  const methods = ["keyword", "vector", "lexical", "graph", "hybrid"] as const;
  const withGold = allQuestions.filter((q) => q.gold.length > 0);
  const rows: Record<string, unknown>[] = [];
  const totals: Record<string, { hit1: number; hitk: number; rr: number; ms: number }> = {};
  for (const m of methods) totals[m] = { hit1: 0, hitk: 0, rr: 0, ms: 0 };

  for (const q of withGold) {
    const query = retrievalQuery(q.question, q.history);
    const row: Record<string, unknown> = { id: q.id, type: q.type, query };
    for (const m of methods) {
      const t = performance.now();
      let urls: string[];
      let ids: string[];
      if (m === "keyword") {
        const hits = await keywordStore.search(query, { limit: k });
        urls = hits.map((h) => h.card.source.url ?? "");
        ids = hits.map((h) => h.card.id);
      } else {
        const res = await fetch(`${knowledgeUrl}/search`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query, limit: k, mode: m }),
        });
        const body = (await res.json()) as { hits: ServiceHit[] };
        urls = body.hits.map((h) => h.url);
        ids = body.hits.map((h) => h.id);
      }
      const ms = performance.now() - t;
      const firstGold = urls.findIndex((u) => isGold(q, u));
      totals[m].hit1 += firstGold === 0 ? 1 : 0;
      totals[m].hitk += firstGold >= 0 ? 1 : 0;
      totals[m].rr += firstGold >= 0 ? 1 / (firstGold + 1) : 0;
      totals[m].ms += ms;
      row[m] = { firstGoldRank: firstGold >= 0 ? firstGold + 1 : null, ids, ms: Math.round(ms) };
    }
    rows.push(row);
  }
  writeFileSync(join(outDir, "retrieval.json"), JSON.stringify({ k, questions: withGold.length, rows }, null, 2));

  const n = withGold.length;
  const lines = [
    `### Retrieval (${n} questions with known sources, top ${k})`,
    "",
    "| Method | Gold source ranked 1st | Gold source in top " + k + " | MRR | Avg ms |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...methods.map(
      (m) =>
        `| ${m} | ${pct(totals[m].hit1, n)} | ${pct(totals[m].hitk, n)} | ${(totals[m].rr / n).toFixed(2)} | ${Math.round(totals[m].ms / n)} |`,
    ),
    "",
    "Misses (hybrid): " +
      (rows
        .filter((r) => (r.hybrid as { firstGoldRank: number | null }).firstGoldRank === null)
        .map((r) => r.id)
        .join(", ") || "none"),
  ];
  return lines.join("\n");
}

// ----- part 2: agent, end to end --------------------------------------------------
async function benchAgent(): Promise<string> {
  const provider = (arg("--provider", "openrouter") ?? "openrouter") as ProviderName;
  const model = arg("--model");
  const backends = (arg("--backends", "demo,cognee") ?? "").split(",").filter(Boolean);
  const profile = JSON.parse(
    readFileSync(new URL("../../data/demo/profile.json", import.meta.url), "utf8"),
  ) as Profile;
  const sections: string[] = [];

  for (const backend of backends) {
    const store: KnowledgeStore = createStore(backend);
    const records: Record<string, unknown>[] = [];
    for (const q of allQuestions) {
      let res: AskResponse | undefined;
      let error: string | undefined;
      try {
        res = await ask({ question: q.question, history: q.history, provider, model }, { store, profile });
      } catch (e) {
        error = (e as Error).message;
      }
      const answer = res?.answer ?? "";
      const low = answer.toLowerCase();
      const cited = new Set([...answer.replace(/\u3010/g, "[").replace(/\u3011/g, "]").matchAll(/\[([A-Z]+\d+)\]/g)].map((m) => m[1]));
      const shown = res?.cards ?? [];
      const abstained = /not in your emergency pack/i.test(answer);
      const rec = {
        id: q.id,
        type: q.type,
        backend,
        provider,
        error,
        answer,
        cards: shown.map((c) => ({ id: c.id, ref: c.ref, pinned: c.pinned, url: c.source.url })),
        dangers: res?.dangers ?? [],
        flags: res?.flags ?? [],
        goldShown: shown.some((c) => isGold(q, c.source.url)),
        goldCited: shown.some((c) => cited.has(c.id) && isGold(q, c.source.url)),
        expectHit: (q.expectAny ?? []).some((e) => low.includes(e.toLowerCase())),
        abstained,
        dangerOk: q.danger ? (res?.dangers ?? []).includes(q.danger) : null,
        inventedNumber: (res?.flags ?? []).some((f) => f.startsWith("number-not-in-cards") || f === "dose-like-number"),
        timingsMs: res?.timingsMs,
      };
      records.push(rec);
      const mark = q.type === "out-of-scope" ? (abstained ? "abstained" : "ANSWERED") : rec.goldCited ? "gold-cited" : rec.goldShown ? "gold-shown" : "no-gold";
      console.log(`[${backend}/${provider}] ${q.id.padEnd(18)} ${mark.padEnd(10)} expect=${rec.expectHit} flags=${rec.flags.join("|") || "-"} ${res?.timingsMs.total ?? "ERR"}ms`);
    }
    writeFileSync(join(outDir, `agent-${backend}-${provider}.json`), JSON.stringify(records, null, 2));

    const inScope = records.filter((r) => r.type !== "out-of-scope");
    const oos = records.filter((r) => r.type === "out-of-scope");
    const withDanger = records.filter((r) => r.dangerOk !== null);
    const count = (rs: Record<string, unknown>[], f: string) => rs.filter((r) => r[f] === true).length;
    const avg = (rs: Record<string, unknown>[], f: "retrieval" | "model" | "total") =>
      Math.round(rs.reduce((s, r) => s + ((r.timingsMs as Record<string, number> | undefined)?.[f] ?? 0), 0) / Math.max(1, rs.length));
    sections.push(
      [
        `### Agent: backend ${backend}, ${provider}${model ? ` ${model}` : ""} (${records.length} questions)`,
        "",
        "| Measure | Result |",
        "| --- | ---: |",
        `| In-scope: a gold source was shown to the model | ${pct(count(inScope, "goldShown"), inScope.length)} |`,
        `| In-scope: the answer cited a gold source | ${pct(count(inScope, "goldCited"), inScope.length)} |`,
        `| In-scope: answer contains an expected phrase | ${pct(count(inScope, "expectHit"), inScope.length)} |`,
        `| In-scope: wrongly said "not in your pack" | ${pct(count(inScope, "abstained"), inScope.length)} |`,
        `| Out-of-scope: correctly said "not in your pack" | ${pct(count(oos, "abstained"), oos.length)} |`,
        `| Any answer with an invented number or dose (flag) | ${pct(count(records, "inventedNumber"), records.length)} |`,
        `| Answers with any grounding flag | ${pct(records.filter((r) => (r.flags as string[]).length > 0).length, records.length)} |`,
        `| Danger rule fired when expected | ${pct(count(withDanger, "dangerOk"), withDanger.length)} |`,
        `| Avg retrieval / model / total ms | ${avg(records, "retrieval")} / ${avg(records, "model")} / ${avg(records, "total")} |`,
        `| Errors | ${records.filter((r) => r.error).length} |`,
      ].join("\n"),
    );
  }
  return sections.join("\n\n");
}

const summary = part === "retrieval" ? await benchRetrieval() : await benchAgent();
writeFileSync(join(outDir, `summary-${part}.md`), summary + "\n");
console.log("\n" + summary + `\n\nResults in ${outDir}`);
