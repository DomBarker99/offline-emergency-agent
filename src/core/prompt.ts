// Prompt assembly. The only place that decides what text the model sees.
import type { Card, Profile, Situation } from "./types.ts";

export const PROMPT_VERSION = "2026-10-22.1"; // bump when rules change; recorded in every audit entry

export function buildInstructions(profile: Profile): string {
  return [
    "You are an offline emergency assistant running on the user's laptop with no internet.",
    "Answer ONLY from the cards provided with each question. Cite card IDs in square brackets, e.g. [C2].",
    "Be brief: numbered steps, at most 6.",
    "If the cards do not contain the answer, say exactly 'That is not in your emergency pack.' and suggest which official source to check when possible.",
    "Never invent phone numbers, addresses, routes or medication doses.",
    "Safety first: if the user describes immediate danger (rising water, fire, gas, injury), give the protective action first; a plan card about leaving when officials order it never means staying in danger.",
    "Reply in the same language the user writes in.",
    "",
    "Household profile (from the user's own records):",
    `- Household: ${profile.household}`,
    `- Location: ${profile.location}`,
    `- Medications: ${profile.medications.join("; ") || "none listed"}`,
    `- Meeting points: ${profile.meetingPoints.join("; ")}`,
    ...(profile.notes ?? []).map((n) => `- ${n}`),
  ].join("\n");
}

export function buildUserMessage(cards: Card[], situation: Situation | undefined, question: string): string {
  const cardText = cards.length ? cards.map((c) => `[${c.id}] ${c.title.toUpperCase()}: ${c.body}`).join("\n") : "(no matching cards)";
  const situationText = situation && (situation.scenario || situation.notes.length)
    ? `Current situation: ${[situation.scenario, ...situation.notes].filter(Boolean).join("; ")}\n\n`
    : "";
  return `Cards:\n${cardText}\n\n${situationText}Question: ${question}`;
}
