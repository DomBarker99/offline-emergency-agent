// Local HTTP API: the bridge between the agent core and ANY user interface
// (a browser page, a desktop window, a test script). Binds to 127.0.0.1 only.
// Usage: npm run serve   ->  http://127.0.0.1:8787
//   GET  /api/health   liveness
//   GET  /api/models   logical models and providers from config
//   POST /api/ask      { question, history?, situation?, provider?, model? } -> AskResponse
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { ask } from "../core/agent.ts";
import { loadModels } from "../core/config.ts";
import { loadDemoStore } from "../core/knowledge.ts";
import type { AskRequest, Profile } from "../core/types.ts";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT ?? 8787);
const MAX_BODY = 64 * 1024;

const store = loadDemoStore();
const profile = JSON.parse(readFileSync(new URL("../../data/demo/profile.json", import.meta.url), "utf8")) as Profile;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

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

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/api/health") return send(res, 200, { ok: true });
    if (req.method === "GET" && req.url === "/api/models") {
      const cfg = loadModels();
      return send(res, 200, { defaultModel: cfg.defaultModel, providers: Object.keys(cfg.providers), models: Object.keys(cfg.models) });
    }
    if (req.method === "POST" && req.url === "/api/ask") {
      const body = (await readJson(req)) as Partial<AskRequest>;
      if (typeof body.question !== "string" || !body.question.trim() || body.question.length > 2000) {
        return send(res, 400, { error: "question must be a non-empty string up to 2000 characters" });
      }
      return send(res, 200, await ask(body as AskRequest, { store, profile }));
    }
    send(res, 404, { error: "not found" });
  } catch (err) {
    send(res, 500, { error: (err as Error).message });
  }
});

server.listen(PORT, HOST, () => console.log(`agent API on http://${HOST}:${PORT}  (POST /api/ask)`));
