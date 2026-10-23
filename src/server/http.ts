/**
 * Local HTTP API: the bridge between the agent core and any graphical interface.
 *
 * A browser page or desktop window can't call TypeScript functions directly. It sends HTTP
 * requests instead. This server receives them, calls `ask()` (src/core/agent.ts) and returns
 * the result as JSON. Uses only Node's built-in `http` module, no web framework.
 *
 * Binds to 127.0.0.1 only, so it's reachable from this computer and not from the network.
 *
 * Usage:  npm run serve        (port 8787; change with the PORT environment variable)
 *
 * Endpoints:
 *   GET  /api/health   -> { ok: true }                    is the server up?
 *   GET  /api/models   -> { defaultModel, providers, models }  what can be selected
 *   POST /api/ask      body: AskRequest (src/core/types.ts) -> AskResponse
 *
 * Example:
 *   curl -X POST http://127.0.0.1:8787/api/ask \
 *     -H 'Content-Type: application/json' \
 *     -d '{"question":"Can I run the generator in the garage?"}'
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { ask } from "../core/agent.ts";
import { loadModels } from "../core/config.ts";
import { createStore } from "../core/stores.ts";
import type { AskRequest, Profile } from "../core/types.ts";

const HOST = "127.0.0.1"; // loopback only: never exposed to the network
const PORT = Number(process.env.PORT ?? 8787);
const MAX_BODY = 64 * 1024; // reject request bodies over 64 KB
const MAX_QUESTION_CHARS = 2000;

// Loaded once at startup and shared by all requests.
// Which knowledge to use comes from KNOWLEDGE_BACKEND (see src/core/stores.ts).
const store = createStore();
const profile = JSON.parse(
  readFileSync(new URL("../../data/demo/profile.json", import.meta.url), "utf8"),
) as Profile;

/** Sends a JSON response with the given HTTP status code. */
function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Reads the request body and parses it as JSON.
 * The body arrives in chunks; we collect them, enforcing MAX_BODY as we go.
 * @throws if the body is too large or isn't valid JSON (reported to the client as a 500)
 */
async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Routes each incoming request to the matching endpoint. */
const server = createServer(async (req, res) => {
  try {
    // GET /api/health: liveness check for interfaces and scripts.
    if (req.method === "GET" && req.url === "/api/health") {
      return send(res, 200, { ok: true });
    }

    // GET /api/models: lets a UI build a model/provider picker from config.
    if (req.method === "GET" && req.url === "/api/models") {
      const cfg = loadModels();
      return send(res, 200, {
        defaultModel: cfg.defaultModel,
        providers: Object.keys(cfg.providers),
        models: Object.keys(cfg.models),
      });
    }

    // POST /api/ask: the main endpoint. Validate the question, then hand off to the agent.
    if (req.method === "POST" && req.url === "/api/ask") {
      const body = (await readJson(req)) as Partial<AskRequest>;
      const question = body.question;
      if (typeof question !== "string" || !question.trim() || question.length > MAX_QUESTION_CHARS) {
        return send(res, 400, { error: `question must be a non-empty string up to ${MAX_QUESTION_CHARS} characters` });
      }
      return send(res, 200, await ask(body as AskRequest, { store, profile }));
    }

    send(res, 404, { error: "not found" });
  } catch (err) {
    // Unexpected failures (bad JSON, model server down, missing API key) become a 500 with the message.
    send(res, 500, { error: (err as Error).message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`agent API on http://${HOST}:${PORT}  (POST /api/ask)`);
});
