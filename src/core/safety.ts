/**
 * Deterministic safety layer: plain rules, no AI, easy to test and to audit.
 *
 * It does two jobs, one on each side of the model call:
 *
 *  1. routeSafety()  BEFORE the model (step 1 of the flow in agent.ts)
 *     Looks for danger words in the question ("water is rising", "smell gas", ...).
 *     For each match, it pins that scenario's "immediate" cards, so the life-safety
 *     instructions are always in front of the model even if keyword search would miss them.
 *
 *  2. checkAnswer()  AFTER the model (step 5, run as an SDK output guardrail)
 *     Flags answers that break the rules: no citation, citing cards that weren't provided,
 *     phone numbers or medication doses that don't appear in the cards. Flags are reported
 *     alongside the answer and written to the audit log; they never silently change it.
 *
 * Why rules instead of asking the model? Small local models sometimes misread instructions
 * (e.g. treating "leave when officials order it" as "wait" while water is rising).
 * Rules behave the same way every time.
 */
import type { KnowledgeStore } from "./knowledge.ts";

/** One danger pattern and the card scenario it maps to. */
interface DangerRule {
  /** Name reported in AskResponse.dangers and the audit log. */
  id: string;
  /** Cards whose `scenarios` include this value (and whose danger is "immediate") get pinned. */
  scenario: string;
  /** Case-insensitive pattern matched against the user's question. */
  pattern: RegExp;
}

/**
 * The danger rules. Add a rule here to cover a new emergency.
 * `\b` means "word boundary" so "fire" doesn't match "firework"; `/i` = ignore case.
 * Spanish phrases are included for common cases (the agent answers in the user's language).
 */
const DANGER_RULES: DangerRule[] = [
  {
    id: "flood",
    scenario: "flood",
    pattern: /\b(water (is )?(rising|coming in)|flood(s|ing|ed)?|flash flood|swept away)\b/i,
  },
  {
    id: "gas",
    scenario: "gas",
    pattern: /\b(smell(s|ing)? (of )?gas|gas leak|huele a gas)\b/i,
  },
  {
    id: "fire",
    scenario: "fire",
    // "(wild)?fires?" also matches "wildfire" and "fires".
    pattern: /\b((wild)?fires?|smoke|smoky|burning|incendio|humo)\b/i,
  },
  {
    // A fuel-burning appliance AND an enclosed place in the same sentence.
    // `[^.?!]*` = "any characters except sentence-ending punctuation".
    id: "carbon-monoxide",
    scenario: "power-outage",
    pattern: /\b(generator|grill|camp stove|carbon monoxide)\b[^.?!]*\b(inside|indoors|garage|kitchen|house)\b/i,
  },
  {
    // Shaking happening now, or the aftermath where people get hurt (gas, aftershocks).
    id: "earthquake",
    scenario: "earthquake",
    pattern: /\b(earthquakes?|quakes?|shaking|aftershocks?|terremoto|temblor)\b/i,
  },
  {
    // Heat illness signs: these need action now, not a reading list.
    id: "heat",
    scenario: "extreme-heat",
    // Named heat illness, or warning signs (dizzy, confused, fainting, hot dry skin) mentioned with heat.
    pattern: /\b(heat ?stroke|heat exhaustion|overheat(ing|ed)?|too hot|stopped sweating|golpe de calor)\b|\b(dizzy|confused|faint(ed|ing)?|hot,? (and )?dry skin)\b[^.?!]*\bheat\b|\bheat\b[^.?!]*\b(dizzy|confused|faint(ed|ing)?|hot,? (and )?dry)\b/i,
  },
];

/** Result of routeSafety(). */
export interface SafetyRoute {
  /** IDs of the rules that matched, e.g. ["flood"]. */
  dangers: string[];
  /** Card IDs the knowledge search must include first. */
  pinnedIds: string[];
}

/**
 * Step 1: checks the question against DANGER_RULES and decides which cards to pin.
 *
 * Example: "Water is rising, should I drive?" matches "flood", so every card with
 * danger "immediate" and scenario "flood" (the "turn around, don't drown" card) is pinned.
 */
export function routeSafety(question: string, store: KnowledgeStore): SafetyRoute {
  const matched = DANGER_RULES.filter((rule) => rule.pattern.test(question));
  const scenarios = new Set(matched.map((rule) => rule.scenario));

  const pinnedIds = store
    .all()
    .filter((card) => card.danger === "immediate" && card.scenarios.some((s) => scenarios.has(s)))
    .map((card) => card.id);

  return { dangers: matched.map((rule) => rule.id), pinnedIds };
}

/**
 * Phone-number-like text: 7+ digits with optional spaces/dashes/dots/parentheses,
 * or a bare emergency number. `g` = find all matches, not just the first.
 */
const PHONE = /(\+?\d[\d\s().-]{6,}\d)|\b(911|112|999)\b/g;

/** Medication-dose-like text, e.g. "325 mg", "2 tablets", "5 ml". */
const DOSE = /\b\d+(\.\d+)?\s*(mg|milligrams?|ml|tablets?|pills?|teaspoons?)\b/i;

/**
 * Step 5: inspects the model's answer and returns a list of problems ("flags").
 *
 * @param answer        the model's final text
 * @param providedIds   IDs of the cards the model was shown
 * @param providedText  the exact message the model received (cards + question), used to
 *                      tell whether a number in the answer came from the cards or was invented
 * @returns flags such as "no-citation", "unknown-citation:C9",
 *          "number-not-in-cards:555-0100", "dose-like-number". Empty array = looks fine.
 */
export function checkAnswer(answer: string, providedIds: string[], providedText: string): string[] {
  const flags: string[] = [];

  // Some models write citations with full-width brackets 【C3】; normalize to [C3].
  const normalized = answer.replace(/\u3010/g, "[").replace(/\u3011/g, "]");

  // Every "[C<number>]" (or similar ID) the answer cites.
  const cited = [...normalized.matchAll(/\[([A-Z]+\d+)\]/g)].map((m) => m[1]);

  // An answer that correctly says "not in your emergency pack" needs no citation.
  const abstained = /not in your emergency pack/i.test(answer);
  if (cited.length === 0 && !abstained) {
    flags.push("no-citation");
  }

  // Citing a card the model was never shown means it made the citation up.
  for (const id of new Set(cited)) {
    if (!providedIds.includes(id)) flags.push(`unknown-citation:${id}`);
  }

  // Any phone-like number must appear somewhere in what the model was given.
  for (const match of answer.matchAll(PHONE)) {
    const number = match[0].trim();
    if (!providedText.includes(number)) flags.push(`number-not-in-cards:${number}`);
  }

  // A dose in the answer is only acceptable if the cards contained a dose too.
  if (DOSE.test(answer) && !DOSE.test(providedText)) {
    flags.push("dose-like-number");
  }

  return flags;
}
