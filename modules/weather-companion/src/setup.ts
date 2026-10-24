/**
 * Setup: everything the screen needs that doesn't change while the app runs. Served once by GET /api/setup.
 *
 *   - the scenario (AGENT_SCENARIO in .env) and the online model setting (AGENT_PROVIDER)
 *   - the support contact, read-only from data/profile.json (the same record the model sees)
 *   - the official action card for the scenario, from data/cards/library-cards.json: verbatim sentences
 *     from official sources, shown as steps. It works without any model, so it's there even if the model
 *     is slow or down.
 *   - the "Help me now" prompts for the scenario, written for the demo household
 */
import { readFileSync } from "node:fs";
import { PROFILE } from "../../../src/profile.ts";
import type { Hazard } from "./event-pipeline.ts";

/** One quoted sentence of an action card, with where it comes from. */
interface CardQuote {
  passageId: string;
  quote: string;
  url: string;
  publisher: string;
}
interface Card {
  id: string;
  title: string;
  scenarios: string[];
  source: { name: string; url?: string; updated?: string | null };
  quotes: CardQuote[];
  reviewed: boolean;
}

/** The app's scenario names -> the scenario names used on the cards. */
const CARD_SCENARIO: Record<Hazard, string> = {
  flood: "flood",
  fire: "fire",
  earthquake: "earthquake",
  outage: "power-outage",
  heat: "extreme-heat",
};

/** Words for the screen, per scenario. */
const NAMES: Record<Hazard, { alert: string; searchWords: string }> = {
  flood: { alert: "Flood warning", searchWords: "flood" },
  fire: { alert: "Wildfire warning", searchWords: "wildfire smoke" },
  earthquake: { alert: "Earthquake alert", searchWords: "earthquake" },
  outage: { alert: "Power outage", searchWords: "power outage" },
  heat: { alert: "Extreme heat warning", searchWords: "extreme heat" },
};

/**
 * "Help me now": four questions people in this household would really ask. Each one is sent to the
 * assistant as if typed. They mention the household (Maria's insulin, Sam's asthma, Biscuit the dog)
 * so the demo shows that answers use the profile.
 */
const PROMPTS: Record<Hazard, string[]> = {
  flood: [
    "Water is coming into our apartment. What do we do right now?",
    "Should we leave? Maria walks with a cane.",
    "How do we keep Maria's insulin safe if the power goes out?",
    "What should we take for Biscuit?",
  ],
  fire: [
    "There's smoke outside. Should we stay or go?",
    "Sam has asthma. How do we keep the smoke out?",
    "What do we take if we have to evacuate?",
    "How do we get Biscuit ready to leave?",
  ],
  earthquake: [
    "The shaking just stopped. What do we do now?",
    "I smell gas after the earthquake.",
    "Is it safe to stay inside the apartment?",
    "There may be aftershocks. How do we get ready?",
  ],
  outage: [
    "The power is out. What about Maria's insulin?",
    "Can we run a generator in the garage?",
    "How long is the food in the fridge safe?",
    "How do we stay safe tonight without power?",
  ],
  heat: [
    "It's very hot inside and we have no AC. What do we do?",
    "Maria feels dizzy and confused in this heat.",
    "How do we keep Lily and Biscuit cool?",
    "Where can we go to cool off?",
  ],
};

const CARDS: Card[] = JSON.parse(readFileSync(new URL("../../../data/cards/library-cards.json", import.meta.url), "utf8"));

/** The official card for a scenario, shaped for the screen. */
export function cardFor(scenario: Hazard) {
  const card = CARDS.find((c) => c.scenarios.includes(CARD_SCENARIO[scenario]));
  if (!card) return null;
  // Publishers in the order they first appear, each with the first page quoted from it.
  const sources = new Map<string, string>();
  for (const q of card.quotes) if (!sources.has(q.publisher)) sources.set(q.publisher, q.url);
  return {
    id: card.id,
    title: card.title,
    steps: card.quotes.map((q) => q.quote),
    sources: [...sources].map(([name, url]) => ({ name, url })),
    reviewed: card.reviewed,
  };
}

/** The JSON behind GET /api/setup. */
export function setupFor(scenario: Hazard, provider: "local" | "openrouter") {
  const contact = PROFILE.plan.supportContact;
  return {
    scenario,
    provider,
    alertName: NAMES[scenario].alert,
    contact: { name: contact.name, relation: contact.relation, city: contact.city, phone: contact.phone },
    card: cardFor(scenario),
    prompts: PROMPTS[scenario],
  };
}

/** Words added to the library search for this scenario (see chat.ts). */
export const searchWordsFor = (scenario: Hazard) => NAMES[scenario].searchWords;
