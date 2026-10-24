/**
 * Knowledge store: where cards live and how the relevant ones are found.
 *
 * DESIGN
 * The rest of the app depends only on the `KnowledgeStore` interface below, never on a
 * concrete storage technology. Two implementations exist:
 *   - `DemoKeywordStore` (this file): cards from a JSON file, ranked by shared words.
 *   - `CogneeStore` (knowledge-cognee.ts): the official library, searched through the local
 *     Cognee pack service, plus action cards.
 * Pick one with KNOWLEDGE_BACKEND (see stores.ts). Swapping doesn't touch the agent, server or UI.
 *
 * `search()` returns a Promise because a store may need to ask another local process
 * (the Cognee service); callers `await` it.
 *
 * Step 2 of the request flow (see agent.ts).
 */
import { readFileSync } from "node:fs";
import type { Card } from "./types.ts";

/** Options for a search. */
export interface SearchOptions {
  /** Maximum number of cards to return (pinned cards always fit, even past the limit). */
  limit: number;
  /**
   * Card IDs that must be included first, regardless of how well they match the words.
   * Supplied by the safety router (safety.ts) for life-safety cards.
   */
  pinnedIds?: string[];
}

/** One search result. */
export interface SearchHit {
  card: Card;
  /** true = included because the safety router demanded it, not because of word matching. */
  pinned: boolean;
  /** Relevance score (higher is better). Pinned cards use Infinity so they sort first. */
  score: number;
}

/** What any knowledge backend must provide. */
export interface KnowledgeStore {
  /** Most relevant cards for a question, pinned cards first. */
  search(query: string, opts: SearchOptions): Promise<SearchHit[]>;
  /** One line describing the store, shown at startup (e.g. "demo cards: 6"). */
  describe(): string;
  /** One card by ID, or undefined if it doesn't exist. */
  get(id: string): Card | undefined;
  /** Every card (the safety router uses this to find "immediate" cards for a scenario). */
  all(): Card[];
}

// ---------------------------------------------------------------------------
// Temporary keyword-based implementation
// ---------------------------------------------------------------------------

/**
 * Common words that carry no meaning for matching ("the", "can", ...).
 * Without this list, nearly every card would match nearly every question.
 */
const STOPWORDS = new Set(
  (
    "a an and are can do does for from how i if in is it my of on or our should " +
    "the to we what when where which who will with you your"
  ).split(" "),
);

/**
 * Splits text into lowercase words for matching.
 * "Can I run the generator?" -> ["run", "generator"]
 * (words of 2 letters or fewer, and stopwords, are dropped)
 */
function tokens(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return words.filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/**
 * TEMPORARY store: cards loaded from a JSON file, ranked by how many question words
 * appear in each card's title, scenarios and body.
 *
 * Limitation: purely literal. "dog" will not match a card about a "pet carrier".
 * The planned SQLite pack (full-text and/or vector search) addresses this.
 */
export class DemoKeywordStore implements KnowledgeStore {
  private readonly cards: Card[];

  constructor(cards: Card[]) {
    this.cards = cards;
  }

  get(id: string): Card | undefined {
    return this.cards.find((c) => c.id === id);
  }

  all(): Card[] {
    // Return a copy so callers can't accidentally reorder or modify the store's own list.
    return [...this.cards];
  }

  describe(): string {
    return `keyword search over ${this.cards.length} cards`;
  }

  // `async` makes this return a Promise, matching the interface; the work itself is synchronous.
  async search(query: string, opts: SearchOptions): Promise<SearchHit[]> {
    // Words from the question, as a Set for fast "is this word in the question?" checks.
    const questionWords = new Set(tokens(query));

    // 1. Pinned cards: look them up by ID and drop any IDs that don't exist.
    //    `(c): c is Card => !!c` tells TypeScript the filtered list has no undefined values.
    const pinned = (opts.pinnedIds ?? [])
      .map((id) => this.get(id))
      .filter((c): c is Card => !!c);

    // 2. Every other card: score = number of its words that also appear in the question.
    const scored = this.cards
      .filter((card) => !pinned.includes(card)) // don't list a pinned card twice
      .map((card) => {
        const cardWords = tokens(`${card.title} ${card.scenarios.join(" ")} ${card.body}`);
        const score = cardWords.filter((w) => questionWords.has(w)).length;
        return { card, pinned: false, score };
      })
      .filter((hit) => hit.score > 0) // no shared words = not relevant
      // Highest score first. Ties are broken by card ID so results are always in the same order.
      .sort((a, b) => b.score - a.score || a.card.id.localeCompare(b.card.id));

    // 3. Pinned first, then the best matches, cut to the limit.
    //    If there are more pinned cards than the limit, keep them all (safety wins).
    const hits: SearchHit[] = [
      ...pinned.map((card) => ({ card, pinned: true, score: Infinity })),
      ...scored,
    ];
    return hits.slice(0, Math.max(opts.limit, pinned.length));
  }
}

/**
 * Loads the demo cards shipped in data/demo/cards.json.
 * The default path is resolved relative to this file (see `import.meta.url` in config.ts).
 */
export function loadDemoStore(path = new URL("../../data/demo/cards.json", import.meta.url)): DemoKeywordStore {
  const cards = JSON.parse(readFileSync(path, "utf8")) as Card[];
  return new DemoKeywordStore(cards);
}
