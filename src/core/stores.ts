/**
 * Chooses the knowledge store for this process, from environment variables.
 *
 * Used by every entry point (terminal chat, HTTP server, benchmark) so they all behave the same.
 *
 *   KNOWLEDGE_BACKEND=demo    (default) the 6 demo cards with keyword search. No other process needed.
 *   KNOWLEDGE_BACKEND=cognee  the official library through the Cognee pack service, plus action cards.
 *       KNOWLEDGE_URL   where the service listens (default http://127.0.0.1:8788)
 *       CARDS_FILE      action cards JSON (default data/cards/library-cards.json)
 *       KNOWLEDGE_MODE  vector (default) | hybrid | lexical | graph   (for comparisons)
 *
 * Start the service first:  npm run knowledge   (see package.json and knowledge/serve.py)
 */
import { loadDemoStore, type KnowledgeStore } from "./knowledge.ts";
import { CogneeStore, loadCards } from "./knowledge-cognee.ts";

/** Builds the store named by KNOWLEDGE_BACKEND. Throws on an unknown name, so typos fail loudly. */
export function createStore(backend = process.env.KNOWLEDGE_BACKEND ?? "demo"): KnowledgeStore {
  if (backend === "demo") return loadDemoStore();
  if (backend === "cognee") {
    const cardsPath = process.env.CARDS_FILE ?? new URL("../../data/cards/library-cards.json", import.meta.url);
    return new CogneeStore(process.env.KNOWLEDGE_URL ?? "http://127.0.0.1:8788", loadCards(cardsPath));
  }
  throw new Error(`Unknown KNOWLEDGE_BACKEND "${backend}" (use "demo" or "cognee")`);
}
