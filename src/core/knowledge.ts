// Knowledge memory: where cards come from and how they are found.
// Everything else talks to the KnowledgeStore INTERFACE, so the storage can change
// (today: demo JSON + simple keyword scoring; next: a SQLite pack with full-text search)
// without touching the agent, the server or the UI.
import { readFileSync } from "node:fs";
import type { Card } from "./types.ts";

export interface SearchOptions {
  limit: number;
  pinnedIds?: string[]; // always included first (from the safety router)
}

export interface SearchHit {
  card: Card;
  pinned: boolean;
  score: number;
}

export interface KnowledgeStore {
  search(query: string, opts: SearchOptions): SearchHit[];
  get(id: string): Card | undefined;
  all(): Card[];
}

const STOPWORDS = new Set(
  "a an and are can do does for from how i if in is it my of on or our should the to we what when where which who will with you your".split(" "),
);

function tokens(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g)?.filter((t) => t.length > 2 && !STOPWORDS.has(t)) ?? [];
}

/** TEMPORARY store: cards from a JSON file, ranked by how many question words they contain. */
export class DemoKeywordStore implements KnowledgeStore {
  private readonly cards: Card[];

  constructor(cards: Card[]) {
    this.cards = cards;
  }

  get(id: string): Card | undefined {
    return this.cards.find((c) => c.id === id);
  }

  all(): Card[] {
    return [...this.cards];
  }

  search(query: string, opts: SearchOptions): SearchHit[] {
    const q = new Set(tokens(query));
    const pinned = (opts.pinnedIds ?? []).map((id) => this.get(id)).filter((c): c is Card => !!c);
    const scored = this.cards
      .filter((c) => !pinned.includes(c))
      .map((card) => {
        const words = tokens(`${card.title} ${card.scenarios.join(" ")} ${card.body}`);
        const score = words.filter((w) => q.has(w)).length;
        return { card, pinned: false, score };
      })
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score || a.card.id.localeCompare(b.card.id));
    const hits = [...pinned.map((card) => ({ card, pinned: true, score: Infinity })), ...scored];
    return hits.slice(0, Math.max(opts.limit, pinned.length));
  }
}

export function loadDemoStore(path = new URL("../../data/demo/cards.json", import.meta.url)): DemoKeywordStore {
  return new DemoKeywordStore(JSON.parse(readFileSync(path, "utf8")) as Card[]);
}
