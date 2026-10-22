// The agent itself: one question in, one grounded answer out.
// ask() is the ONLY entry point used by every interface (terminal chat, HTTP server, desktop app).
//
// Flow for each question:
//   1. safety router (rules)    -> danger words pin "immediate" cards
//   2. knowledge search         -> top cards for the question
//   3. prompt assembly          -> rules + profile (instructions) + cards + situation + question
//   4. model call (Agents SDK)  -> local llama-server or OpenRouter, per config
//   5. output guardrail (rules) -> flags missing/unknown citations, invented numbers, doses
//   6. audit log                -> one JSONL line with everything above
import { randomUUID } from "node:crypto";
import { Agent, assistant, user, type OutputGuardrail } from "@openai/agents";
import { writeTurn, installLocalTracing } from "./audit.ts";
import type { KnowledgeStore } from "./knowledge.ts";
import { createModelHandle } from "./models.ts";
import { buildInstructions, buildUserMessage, PROMPT_VERSION } from "./prompt.ts";
import { checkAnswer, routeSafety } from "./safety.ts";
import type { AskRequest, AskResponse, Profile } from "./types.ts";

/** Data available to guardrails and tools during one run (the SDK's "run context"). */
interface RunData {
  providedIds: string[];
  providedText: string;
}

const MAX_CARDS = 4;

// Flag-only guardrail: never blocks the answer, records what's wrong with it.
const groundingGuardrail: OutputGuardrail = {
  name: "grounding-check",
  async execute({ agentOutput, context }) {
    const data = context.context as RunData;
    const flags = checkAnswer(String(agentOutput ?? ""), data.providedIds, data.providedText);
    return { tripwireTriggered: false, outputInfo: { flags } };
  },
};

export interface AgentDeps {
  store: KnowledgeStore;
  profile: Profile;
}

export async function ask(req: AskRequest, deps: AgentDeps): Promise<AskResponse> {
  installLocalTracing();
  const turnId = randomUUID();
  const t0 = performance.now();
  const provider = req.provider ?? "local";
  const { runner, model } = createModelHandle(provider, req.model);

  // 1-2. safety router + knowledge search
  const route = routeSafety(req.question, deps.store);
  const hits = deps.store.search(req.question, { limit: MAX_CARDS, pinnedIds: route.pinnedIds });
  const cards = hits.map((h) => h.card);
  const tRetrieval = performance.now();

  // 3. prompt
  const agent = new Agent<RunData>({
    name: "Emergency assistant",
    instructions: buildInstructions(deps.profile),
    model: model.modelId,
    modelSettings: { temperature: 0.2, maxTokens: 600, providerData: model.extraRequest },
    outputGuardrails: [groundingGuardrail],
  });
  const userMessage = buildUserMessage(cards, req.situation, req.question);
  const input = [
    ...(req.history ?? []).map((t) => (t.role === "user" ? user(t.text) : assistant(t.text))),
    user(userMessage),
  ];

  // 4-5. model call + guardrail
  const result = await runner.run(agent, input, {
    context: { providedIds: cards.map((c) => c.id), providedText: userMessage },
  });
  const tModel = performance.now();
  const answer = String(result.finalOutput ?? "").trim();
  const flags = result.outputGuardrailResults.flatMap(
    (g) => ((g.output.outputInfo as { flags?: string[] } | undefined)?.flags ?? []),
  );

  const response: AskResponse = {
    turnId,
    answer,
    cards: hits.map((h) => ({ id: h.card.id, title: h.card.title, pinned: h.pinned, source: h.card.source })),
    dangers: route.dangers,
    flags,
    model: { provider, logical: model.logicalName, id: model.modelId },
    timingsMs: {
      retrieval: Math.round(tRetrieval - t0),
      model: Math.round(tModel - tRetrieval),
      total: Math.round(tModel - t0),
    },
  };

  // 6. audit
  writeTurn({ ...response, promptVersion: PROMPT_VERSION, question: req.question, situation: req.situation, historyTurns: req.history?.length ?? 0 });
  return response;
}
