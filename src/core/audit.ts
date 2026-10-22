/**
 * Audit trail: a local record of every question and what the agent did with it.
 * Step 6 of the request flow (see agent.ts).
 *
 * Two JSONL files per day ("JSON Lines": one JSON object per line, easy to grep or load):
 *
 *   logs/turns-YYYY-MM-DD.jsonl   One line per question, written by writeTurn():
 *                                 question, cards used, danger matches, answer, flags,
 *                                 model, timings, prompt version.
 *
 *   logs/trace-YYYY-MM-DD.jsonl   The Agents SDK's own trace "spans" (each model call,
 *                                 each guardrail run) for deeper debugging.
 *
 * PRIVACY: by default the Agents SDK uploads traces to OpenAI's tracing dashboard.
 * installLocalTracing() REPLACES that exporter with the local file writer below,
 * so nothing about a conversation leaves the machine.
 *
 * The folder defaults to <repo>/logs and can be changed with the LOG_DIR environment variable.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTraceProcessors, type TracingProcessor } from "@openai/agents";

const LOG_DIR = process.env.LOG_DIR ?? fileURLToPath(new URL("../../logs", import.meta.url));

/** Path of today's file for a given prefix, creating the folder if needed. */
function logFile(prefix: string): string {
  mkdirSync(LOG_DIR, { recursive: true });
  const day = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD" (UTC)
  return join(LOG_DIR, `${prefix}-${day}.jsonl`);
}

/** Appends one JSON object as one line. Synchronous on purpose: simple and nothing is lost on crash. */
function append(prefix: string, record: unknown): void {
  appendFileSync(logFile(prefix), JSON.stringify(record) + "\n");
}

/** Records one question/answer. Called once per ask(), with a timestamp added. */
export function writeTurn(record: Record<string, unknown>): void {
  append("turns", { at: new Date().toISOString(), ...record });
}

// The SDK's Trace and Span types, taken from the TracingProcessor interface so we don't
// depend on internal import paths.
type TraceArg = Parameters<TracingProcessor["onTraceEnd"]>[0];
type SpanArg = Parameters<TracingProcessor["onSpanEnd"]>[0];

/** SDK trace objects provide toJSON(); fall back to the raw object if one doesn't. */
function plain(x: unknown): unknown {
  const maybe = x as { toJSON?: () => unknown };
  return typeof maybe.toJSON === "function" ? maybe.toJSON() : x;
}

/**
 * A trace processor receives events from the SDK as an agent runs. This one writes
 * finished traces and spans to the local trace file and does nothing else.
 * (A "trace" is one whole run; "spans" are the steps inside it.)
 */
class LocalJsonlTraceProcessor implements TracingProcessor {
  async onTraceStart(_trace: TraceArg): Promise<void> {} // only finished items are recorded

  async onTraceEnd(trace: TraceArg): Promise<void> {
    append("trace", { kind: "trace", data: plain(trace) });
  }

  async onSpanStart(_span: SpanArg): Promise<void> {}

  async onSpanEnd(span: SpanArg): Promise<void> {
    append("trace", { kind: "span", data: plain(span) });
  }

  // Writes happen immediately, so there's nothing to flush or shut down.
  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

let installed = false;

/**
 * Replaces the SDK's default (remote) trace exporter with local files.
 * Safe to call repeatedly; only the first call does anything.
 */
export function installLocalTracing(): void {
  if (installed) return;
  setTraceProcessors([new LocalJsonlTraceProcessor()]);
  installed = true;
}

/** Where logs are written (shown by the terminal chat at startup). */
export function logDir(): string {
  return LOG_DIR;
}
