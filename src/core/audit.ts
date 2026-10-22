// Audit trail. Two local JSONL files per day in LOG_DIR (default <repo>/logs, git-ignored):
//   turns-YYYY-MM-DD.jsonl  one line per question: what went in, what came out, why
//   trace-YYYY-MM-DD.jsonl  the Agents SDK's own trace spans (model calls, guardrails)
// installLocalTracing() REPLACES the SDK's default exporter, so nothing is sent to OpenAI.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTraceProcessors, type TracingProcessor } from "@openai/agents";

const LOG_DIR = process.env.LOG_DIR ?? fileURLToPath(new URL("../../logs", import.meta.url));

function logFile(prefix: string): string {
  mkdirSync(LOG_DIR, { recursive: true });
  return join(LOG_DIR, `${prefix}-${new Date().toISOString().slice(0, 10)}.jsonl`);
}

function append(prefix: string, record: unknown): void {
  appendFileSync(logFile(prefix), JSON.stringify(record) + "\n");
}

export function writeTurn(record: Record<string, unknown>): void {
  append("turns", { at: new Date().toISOString(), ...record });
}

type TraceArg = Parameters<TracingProcessor["onTraceEnd"]>[0];
type SpanArg = Parameters<TracingProcessor["onSpanEnd"]>[0];

function plain(x: unknown): unknown {
  const maybe = x as { toJSON?: () => unknown };
  return typeof maybe.toJSON === "function" ? maybe.toJSON() : x;
}

class LocalJsonlTraceProcessor implements TracingProcessor {
  async onTraceStart(_trace: TraceArg): Promise<void> {}
  async onTraceEnd(trace: TraceArg): Promise<void> {
    append("trace", { kind: "trace", data: plain(trace) });
  }
  async onSpanStart(_span: SpanArg): Promise<void> {}
  async onSpanEnd(span: SpanArg): Promise<void> {
    append("trace", { kind: "span", data: plain(span) });
  }
  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

let installed = false;
export function installLocalTracing(): void {
  if (installed) return;
  setTraceProcessors([new LocalJsonlTraceProcessor()]);
  installed = true;
}

export function logDir(): string {
  return LOG_DIR;
}
