/**
 * The app's local server: serves the screen and everything it asks for. Listens on 127.0.0.1 only.
 * The desktop app (app/main.ts) starts it inside its own process; `npm run weather:demo` runs it alone.
 *
 *   GET  /companion              the screen (public/companion.html)
 *   GET  /animation-studio       the animated window shown inside the screen (+ /studio.js, /vendor/gsap.min.js)
 *   GET  /api/setup              scenario, support contact, official card, "Help me now" prompts (setup.ts)
 *   GET  /api/status             online or offline, and whether the local model is loaded (connectivity.ts)
 *   GET  /api/feed               the latest emergency packet; 503 while offline (feed.ts)
 *   GET  /api/feed?saved=1       the packet even while offline: what the app had saved (first launch offline)
 *   POST /api/simulate-offline   {"offline": true|false}: the hidden presenter key (Ctrl+Shift+O)
 *   POST /api/trigger-emergency  starts the emergency when the app started calm (Ctrl+Shift+E)
 *   POST /api/chat               a question for the assistant (chat.ts -> src/agent.ts)
 *   POST /api/transcribe         a recording (raw 16 kHz float samples) -> {"text"} (src/transcribe.ts)
 *   GET  /v2/context             a scenario packet for any hazard and demo second (tests, debugging)
 *   GET  /health                 liveness, used by app/main.ts to wait for startup
 *
 * Settings come from the environment (app/main.ts loads .env): AGENT_SCENARIO, AGENT_PROVIDER, PORT, and
 * AGENT_START (event = the emergency is active at launch, the default; calm = normal until Ctrl+Shift+E).
 * AGENT_WARM_LOCAL=0 skips loading the local model at start (tests).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { simulateEvent, RequestSchema, HazardSchema } from "./event-pipeline.ts";
import { ChatRequest, answerChat } from "./chat.ts";
import { createConnectivityMonitor } from "./connectivity.ts";
import { createFeed } from "./feed.ts";
import { setupFor } from "./setup.ts";
import { warmLocal } from "../../../src/agent.ts";
import { transcribe, SAMPLE_RATE, MAX_SECONDS } from "../../../src/transcribe.ts";

const scenario = HazardSchema.parse(process.env.AGENT_SCENARIO ?? "flood");
const provider = process.env.AGENT_PROVIDER === "openrouter" ? "openrouter" : "local";
// CONNECTIVITY_PROBE_URL / CONNECTIVITY_INTERVAL_MS: only for tests (point the probe at a server the test controls).
const monitor = createConnectivityMonitor({
  probeUrl: process.env.CONNECTIVITY_PROBE_URL,
  intervalMs: Number(process.env.CONNECTIVITY_INTERVAL_MS) || undefined,
});
const startCalm = process.env.AGENT_START === "calm";
const feed = createFeed(scenario, monitor, Date.now(), startCalm);

// Keep the local model loaded (see warmLocal in src/agent.ts): now, then every 10 minutes. The local
// model server unloads after 15 idle minutes, so this keeps the first offline answer fast.
let localReady = false;
const warm = async () => (localReady = await warmLocal());
if (process.env.AGENT_WARM_LOCAL !== "0") {
  void warm();
  setInterval(warm, 10 * 60_000).unref();
}

// Static files the screen needs, and nothing else.
const PAGES: Record<string, [file: string, type: string]> = {
  "/companion": ["companion.html", "text/html"],
  "/animation-studio": ["animation-studio.html", "text/html"],
  "/studio.js": ["studio.js", "text/javascript"],
  "/vendor/gsap.min.js": ["vendor/gsap.min.js", "text/javascript"],
};

function reply(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

/** Reads a request body up to `limit` bytes; null if it's bigger. */
async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** POSTs must come from our own page: blocks other websites open in a browser from calling the API. */
const sameOrigin = (req: IncomingMessage) => !req.headers.origin || req.headers.origin === `http://${req.headers.host}`;

const SimulateRequest = z.object({ offline: z.boolean() }).strict();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (req.method === "GET" && PAGES[path]) {
      const [file, type] = PAGES[path];
      const body = await readFile(new URL(`../public/${file}`, import.meta.url));
      res.writeHead(200, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store" });
      return res.end(body);
    }
    if (req.method === "GET" && path === "/") {
      res.writeHead(302, { Location: "/companion" });
      return res.end();
    }
    if (req.method === "GET" && path === "/health") return reply(res, 200, { status: "ok" });
    if (req.method === "GET" && path === "/api/setup") return reply(res, 200, setupFor(scenario, provider));
    if (req.method === "GET" && path === "/api/status") return reply(res, 200, { ...monitor.state(), localReady, emergency: feed.active() });

    if (req.method === "GET" && path === "/api/feed") {
      const saved = url.searchParams.get("saved") === "1";
      const packet = saved ? await feed.snapshot() : await feed.read();
      if (!packet) return reply(res, 503, { offline: true });
      return reply(res, 200, { packet, receivedAt: new Date().toISOString(), saved });
    }

    if (req.method === "GET" && path === "/v2/context") {
      const request = RequestSchema.safeParse({
        hazard: url.searchParams.get("hazard") ?? scenario,
        seconds: url.searchParams.has("seconds") ? Number(url.searchParams.get("seconds")) : feed.demoSeconds(),
      });
      if (!request.success) return reply(res, 400, { error: "Invalid hazard or demo seconds" });
      return reply(res, 200, await simulateEvent(request.data));
    }

    if (req.method !== "POST") return reply(res, 404, { error: "Unknown endpoint" });
    if (!sameOrigin(req)) return reply(res, 403, { error: "Origin not allowed" });

    if (path === "/api/simulate-offline") {
      const body = await readBody(req, 1024);
      let parsed;
      try {
        parsed = body && SimulateRequest.safeParse(JSON.parse(body.toString()));
      } catch {
        parsed = null;
      }
      if (!parsed?.success) return reply(res, 400, { error: 'Expected {"offline": true|false}' });
      monitor.setSimulatedOffline(parsed.data.offline);
      return reply(res, 200, monitor.state());
    }

    if (path === "/api/trigger-emergency") {
      feed.trigger();
      return reply(res, 200, { emergency: true });
    }

    if (path === "/api/chat") {
      if (!req.headers["content-type"]?.startsWith("application/json")) return reply(res, 415, { error: "JSON required" });
      const body = await readBody(req, 512 * 1024);
      if (!body) return reply(res, 413, { error: "Request too large" });
      let input;
      try {
        input = ChatRequest.safeParse(JSON.parse(body.toString()));
      } catch {
        return reply(res, 400, { error: "Invalid JSON" });
      }
      if (!input.success) return reply(res, 400, { error: "Invalid chat request" });
      try {
        const answer = await answerChat(input.data, monitor.state().online);
        if (answer.provider === "local") localReady = true;
        return reply(res, 200, answer);
      } catch (error) {
        console.error("chat failed:", error instanceof Error ? error.message : error);
        localReady = false;
        return reply(res, 503, { error: "The assistant on this laptop isn't responding. Check that the local model server is running." });
      }
    }

    if (path === "/api/transcribe") {
      if (req.headers["content-type"] !== "application/octet-stream") return reply(res, 415, { error: "Raw audio required" });
      const body = await readBody(req, SAMPLE_RATE * MAX_SECONDS * 4 + 4096);
      if (!body) return reply(res, 413, { error: `Recording longer than ${MAX_SECONDS} seconds` });
      const aligned = new Uint8Array(body.length - (body.length % 4));
      aligned.set(body.subarray(0, aligned.length));
      try {
        return reply(res, 200, { text: await transcribe(new Float32Array(aligned.buffer)) });
      } catch (error) {
        console.error("transcription failed:", error instanceof Error ? error.message : error);
        return reply(res, 503, { error: "Dictation failed. Please type instead." });
      }
    }

    return reply(res, 404, { error: "Unknown endpoint" });
  } catch (error) {
    console.error(error);
    reply(res, 500, { error: "Server error" });
  }
});

const port = Number(process.env.PORT ?? 4317);
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const actual = typeof address === "object" && address ? address.port : port;
  console.log(`Companion server: http://127.0.0.1:${actual}/companion (scenario ${scenario}${startCalm ? " (starts calm)" : ""}, online model ${provider}, local model ${setupFor(scenario, provider).localModel})`);
});
