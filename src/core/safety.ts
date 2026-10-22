// Deterministic safety layer: plain rules, no AI, fully testable.
// 1. routeSafety(): BEFORE the model, detects danger words and pins "immediate" cards
//    for that scenario so the protective action is always in front of the model.
// 2. checkAnswer(): AFTER the model, flags answers that break the rules (used by the
//    output guardrail in agent.ts). Flags are recorded, never silently dropped.
import type { KnowledgeStore } from "./knowledge.ts";

interface DangerRule {
  id: string;
  scenario: string;
  pattern: RegExp;
}

const DANGER_RULES: DangerRule[] = [
  { id: "flood", scenario: "flood", pattern: /\b(water (is )?(rising|coming in)|flood(ing|ed)?|swept away)\b/i },
  { id: "gas", scenario: "gas", pattern: /\b(smell(s|ing)? (of )?gas|gas leak|huele a gas)\b/i },
  { id: "fire", scenario: "fire", pattern: /\b(fire|smoke|burning|incendio|humo)\b/i },
  {
    id: "carbon-monoxide",
    scenario: "power-outage",
    pattern: /\b(generator|grill|camp stove|carbon monoxide)\b[^.?!]*\b(inside|indoors|garage|kitchen|house)\b/i,
  },
];

export interface SafetyRoute {
  dangers: string[];
  pinnedIds: string[];
}

export function routeSafety(question: string, store: KnowledgeStore): SafetyRoute {
  const matched = DANGER_RULES.filter((r) => r.pattern.test(question));
  const scenarios = new Set(matched.map((r) => r.scenario));
  const pinnedIds = store
    .all()
    .filter((c) => c.danger === "immediate" && c.scenarios.some((s) => scenarios.has(s)))
    .map((c) => c.id);
  return { dangers: matched.map((r) => r.id), pinnedIds };
}

const PHONE = /(\+?\d[\d\s().-]{6,}\d)|\b(911|112|999)\b/g;
const DOSE = /\b\d+(\.\d+)?\s*(mg|milligrams?|ml|tablets?|pills?|teaspoons?)\b/i;

export function checkAnswer(answer: string, providedIds: string[], providedText: string): string[] {
  const flags: string[] = [];
  const normalized = answer.replace(/\u3010/g, "[").replace(/\u3011/g, "]");
  const cited = [...normalized.matchAll(/\[([A-Z]+\d+)\]/g)].map((m) => m[1]);
  const abstained = /not in your emergency pack/i.test(answer);
  if (cited.length === 0 && !abstained) flags.push("no-citation");
  for (const id of new Set(cited)) if (!providedIds.includes(id)) flags.push(`unknown-citation:${id}`);
  for (const m of answer.matchAll(PHONE)) if (!providedText.includes(m[0].trim())) flags.push(`number-not-in-cards:${m[0].trim()}`);
  if (DOSE.test(answer) && !DOSE.test(providedText)) flags.push("dose-like-number");
  return flags;
}
