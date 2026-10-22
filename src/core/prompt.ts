/**
 * Prompt assembly: the ONLY place that decides what text the model sees.
 * Step 3 of the request flow (see agent.ts).
 *
 * The model receives two pieces of text:
 *   1. Instructions (the "system prompt"): the rules plus the household profile.
 *      Built by buildInstructions(). Same for every question in a session.
 *   2. The user message: the retrieved cards, the current situation and the question.
 *      Built by buildUserMessage(). Different for every question.
 *
 * If you change the rules, bump PROMPT_VERSION. It's written to the audit log with every
 * answer, so you can tell which rules produced which answers.
 */
import type { Card, Profile, Situation } from "./types.ts";

/** Version label for the current rules. Format: date + counter. */
export const PROMPT_VERSION = "2026-10-22.1";

/**
 * Builds the instructions: behavior rules first, then the household profile.
 * Each rule addresses a specific failure seen in testing (see comments inline).
 */
export function buildInstructions(profile: Profile): string {
  const rules = [
    "You are an offline emergency assistant running on the user's laptop with no internet.",
    // Grounding: answers must come from the cards, and say which card.
    "Answer ONLY from the cards provided with each question. Cite card IDs in square brackets, e.g. [C2].",
    // People under stress need short, ordered steps.
    "Be brief: numbered steps, at most 6.",
    // Honest abstention instead of guessing. The exact phrase is also detected by safety.ts.
    "If the cards do not contain the answer, say exactly 'That is not in your emergency pack.' and suggest which official source to check when possible.",
    // The most dangerous kinds of invention.
    "Never invent phone numbers, addresses, routes or medication doses.",
    // Fixes a real misreading: "leave when officials order it" interpreted as "wait" during a flood.
    "Safety first: if the user describes immediate danger (rising water, fire, gas, injury), give the protective action first; a plan card about leaving when officials order it never means staying in danger.",
    "Reply in the same language the user writes in.",
  ];

  const profileLines = [
    "Household profile (from the user's own records):",
    `- Household: ${profile.household}`,
    `- Location: ${profile.location}`,
    `- Medications: ${profile.medications.join("; ") || "none listed"}`,
    `- Meeting points: ${profile.meetingPoints.join("; ")}`,
    // Optional free-form notes, one line each (`?? []` handles a profile without notes).
    ...(profile.notes ?? []).map((note) => `- ${note}`),
  ];

  return [...rules, "", ...profileLines].join("\n");
}

/**
 * Builds the user message for one question.
 *
 * Example output:
 *   Cards:
 *   [C1] FLOOD: TURN AROUND, DON'T DROWN: Do not walk, swim or drive through flood water...
 *
 *   Current situation: flood; power out since 6pm
 *
 *   Question: Should I drive to the meeting point?
 */
export function buildUserMessage(cards: Card[], situation: Situation | undefined, question: string): string {
  // Each card on its own line, prefixed with the ID the model must cite.
  const cardText = cards.length
    ? cards.map((c) => `[${c.id}] ${c.title.toUpperCase()}: ${c.body}`).join("\n")
    : "(no matching cards)";

  // Only add a situation line if there is something in it.
  const hasSituation = situation && (situation.scenario || situation.notes.length > 0);
  const situationText = hasSituation
    ? `Current situation: ${[situation.scenario, ...situation.notes].filter(Boolean).join("; ")}\n\n`
    : "";

  return `Cards:\n${cardText}\n\n${situationText}Question: ${question}`;
}
