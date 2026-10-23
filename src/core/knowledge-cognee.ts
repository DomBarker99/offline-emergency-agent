/**
 * CogneeStore: the official emergency library, searched through the local Cognee pack service.
 *
 * WHERE THIS FITS
 * Step 2 of the request flow (see agent.ts), when KNOWLEDGE_BACKEND=cognee (see stores.ts).
 *
 *   agent.ts --search()--> CogneeStore --HTTP POST /search--> knowledge/serve.py (Python, 127.0.0.1)
 *                                                               |
 *                                                    Cognee pack files (read-only, offline)
 *
 * WHAT IT RETURNS
 * Two kinds of knowledge, both shaped as `Card` objects so the rest of the app doesn't care:
 *   - Action cards (kind "card"): short life-safety steps loaded from a JSON file at startup
 *     (data/cards/library-cards.json). The safety router pins them by scenario; they also work
 *     when the search service is down.
 *   - Library passages (kind "passage"): sections of official pages, found by the service. They get
 *     per-question aliases L1, L2, ... (short IDs the model can cite reliably); the real passage ID
 *     ("ready-gov:floods:3") is kept in `ref` and written to the audit log.
 *
 * FAILURE BEHAVIOR
 * If the service can't be reached, search() still returns the pinned cards and logs a warning,
 * so an answer is possible; it never throws because of the library.
 */
import { readFileSync } from "node:fs";
import type { Card } from "./types.ts";
import type { KnowledgeStore, SearchHit, SearchOptions } from "./knowledge.ts";

/** One hit as returned by knowledge/serve.py (fields we use). */
export interface ServiceHit {
  id: string;
  score: number;
  methods: string[];
  text: string;
  heading: string;
  pageTitle: string;
  publisher: string;
  url: string;
  pageDate: string | null;
  fetchedAt: string;
  hazards: string[];
}

/**
 * Converts a library passage into a Card.
 *
 * @param p      passage from the service (or from passages.jsonl, which has the same fields)
 * @param alias  the short ID the model will cite, e.g. "L1"
 */
export function passageToCard(p: ServiceHit, alias: string): Card {
  // "Floods > Prepare NOW" is more useful than repeating the page title twice.
  const heading = p.heading && p.heading !== p.pageTitle ? p.heading : p.pageTitle;
  return {
    id: alias,
    ref: p.id,
    kind: "passage",
    title: heading,
    scenarios: p.hazards ?? [],
    danger: "info",
    body: p.text,
    source: {
      name: p.publisher,
      url: p.url,
      retrieved: p.fetchedAt?.slice(0, 10),
      updated: p.pageDate ?? undefined,
    },
  };
}

/** Loads action cards from a JSON file (an array of Card). */
export function loadCards(path: string | URL): Card[] {
  const cards = JSON.parse(readFileSync(path, "utf8")) as Card[];
  return cards.map((c) => ({ ...c, kind: "card" as const }));
}

export class CogneeStore implements KnowledgeStore {
  private readonly cards: Card[];
  private readonly baseUrl: string;
  /** Passages seen in recent searches, by alias, so get("L2") works while a turn is processed. */
  private lastPassages = new Map<string, Card>();

  /**
   * @param baseUrl  where knowledge/serve.py listens, e.g. "http://127.0.0.1:8788"
   * @param cards    action cards (pinned by the safety router, always available)
   */
  constructor(baseUrl: string, cards: Card[]) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.cards = cards;
  }

  describe(): string {
    return `Cognee library at ${this.baseUrl} + ${this.cards.length} action cards`;
  }

  get(id: string): Card | undefined {
    return this.cards.find((c) => c.id === id) ?? this.lastPassages.get(id);
  }

  /** Action cards only: the library is searched, never listed. */
  all(): Card[] {
    return [...this.cards];
  }

  /**
   * Pinned cards first, then library passages from the service, up to the limit.
   * (Unlike the demo store, unpinned action cards are not keyword-matched here: the library covers
   * those topics, and the safety router pins cards whenever a danger is detected.)
   *
   * @returns hits; passages carry `score` from the service's fused ranking
   */
  async search(query: string, opts: SearchOptions): Promise<SearchHit[]> {
    const pinned = (opts.pinnedIds ?? [])
      .map((id) => this.cards.find((c) => c.id === id))
      .filter((c): c is Card => !!c)
      .map((card) => ({ card, pinned: true, score: Infinity }));

    let passages: SearchHit[] = [];
    try {
      const res = await fetch(`${this.baseUrl}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, limit: opts.limit, mode: process.env.KNOWLEDGE_MODE ?? "hybrid" }),
        // Searches take milliseconds; anything this slow means the service is stuck.
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { hits: ServiceHit[] };
      this.lastPassages.clear();
      passages = body.hits.map((hit, i) => {
        const card = passageToCard(hit, `L${i + 1}`);
        this.lastPassages.set(card.id, card);
        return { card, pinned: false, score: hit.score };
      });
    } catch (err) {
      // Keep going with the pinned cards; the audit log will show zero passages for this turn.
      console.warn(`[knowledge] library search failed (${(err as Error).message}); answering from cards only`);
    }
    return [...pinned, ...passages];
  }
}
