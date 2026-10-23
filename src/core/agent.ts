/**
 * The agent: one question in, one grounded answer out.
 *
 * `ask()` is the single entry point. Every interface (terminal chat, HTTP API, a future
 * desktop UI) calls this same function, so behavior is identical everywhere.
 *
 * REQUEST FLOW (each step lives in its own file):
 *   1. Safety router     safety.ts     danger words pin "immediate" cards           (rules)
 *   2. Knowledge search  knowledge.ts  find the most relevant cards/passages        (search, no AI)
 *                        (+ knowledge-cognee.ts for the official library)
 *   3. Prompt assembly   prompt.ts     rules + profile + cards + situation + question
 *   4. Model call        models.ts     run the agent via the OpenAI Agents SDK      (AI)
 *   5. Grounding check   safety.ts     output guardrail flags rule-breaking answers (rules)
 *   6. Audit log         audit.ts      one JSON line describing all of the above
 *
 * Only step 4 involves a language model. Everything else is ordinary, testable code.
 */
import { randomUUID } from "node:crypto";
import { Agent, assistant, user, type OutputGuardrail } from "@openai/agents";
import { writeTurn, installLocalTracing } from "./audit.ts";
import type { KnowledgeStore } from "./knowledge.ts";
import { createModelHandle } from "./models.ts";
import { buildInstructions, buildUserMessage, PROMPT_VERSION } from "./prompt.ts";
import { checkAnswer, routeSafety } from "./safety.ts";
import type { AskRequest, AskResponse, Profile, Turn } from "./types.ts";

/**
 * Data we hand to the SDK for one run (the SDK calls this the run "context").
 * The SDK passes it through to guardrails and tools but never sends it to the model.
 * Our grounding guardrail needs it to know which cards the model was shown.
 */
interface RunData {
  providedIds: string[]; // IDs of cards included in the prompt
  providedText: string; // the exact user message sent to the model
}

/**
 * How many cards/passages to include per question (pinned cards may push past this).
 * Library passages are longer than demo cards, so the library store gets a few more slots.
 */
const MAX_CARDS = Number(process.env.MAX_CARDS ?? 5);

/**
 * The text used to search the knowledge. Usually just the question. A short follow-up such as
 * "What about the dog?" has no topic of its own, so the previous user question is added in front
 * ("My street is flooding, do we leave? What about the dog?"). Only the search uses this; the
 * model still sees the real question and the conversation history.
 *
 * @param question  the new question
 * @param history   earlier turns, oldest first
 */
export function retrievalQuery(question: string, history: Turn[] = []): string {
  const previous = [...history].reverse().find((t) => t.role === "user");
  if (!previous) return question;
  const words = question.trim().split(/\s+/).length;
  // Signals that the question leans on earlier context: short, or starts like a continuation,
  // or points back with a pronoun.
  const followUp =
    words <= 7 ||
    /^(and|but|what about|how about|what if|also|then|so|ok|okay|y|and if)\b/i.test(question.trim()) ||
    /\b(it|that|this|those|they|them|there)\b/i.test(question);
  return followUp ? `${previous.text} ${question}` : question;
}

/**
 * Output guardrail (step 5). The SDK runs this on the model's final answer.
 *
 * Guardrails can "trip" to reject an answer. This one deliberately never trips
 * (`tripwireTriggered: false`). It only reports flags, so the user always gets the
 * answer plus a visible warning, rather than nothing at all during an emergency.
 */
const groundingGuardrail: OutputGuardrail = {
  name: "grounding-check",
  async execute({ agentOutput, context }) {
    const data = context.context as RunData;
    const flags = checkAnswer(String(agentOutput ?? ""), data.providedIds, data.providedText);
    return { tripwireTriggered: false, outputInfo: { flags } };
  },
};

/** What ask() needs from its caller: where the cards are and whose household this is. */
export interface AgentDeps {
  store: KnowledgeStore;
  profile: Profile;
}

/**
 * Answers one question.
 *
 * @param req   the question, plus optional history/situation/provider/model
 * @param deps  knowledge store and household profile
 * @returns the answer, the cards used, danger matches, flags, model info and timings
 * @throws on configuration errors (unknown model, missing API key) or network failures
 */
export async function ask(req: AskRequest, deps: AgentDeps): Promise<AskResponse> {
  installLocalTracing(); // keep SDK traces local (see audit.ts)

  const turnId = randomUUID();
  const t0 = performance.now(); // high-resolution timer for the timings in the response

  // Pick the provider/model for this question; defaults come from config/models.json.
  const provider = req.provider ?? "local";
  const { runner, model } = createModelHandle(provider, req.model);

  // ----- Step 1: safety router ---------------------------------------------------
  // e.g. "water is rising" -> dangers ["flood"], pinnedIds ["C1"]
  const route = routeSafety(req.question, deps.store);

  // ----- Step 2: knowledge search ------------------------------------------------
  // Pinned cards come first, then the best matches, up to MAX_CARDS.
  const query = retrievalQuery(req.question, req.history);
  const hits = await deps.store.search(query, { limit: MAX_CARDS, pinnedIds: route.pinnedIds });
  const cards = hits.map((hit) => hit.card);
  const tRetrieval = performance.now();

  // ----- Step 3: prompt assembly -------------------------------------------------
  // The Agent bundles instructions, model choice, settings and guardrails.
  // It's cheap to create, so we build a fresh one per question.
  const agent = new Agent<RunData>({
    name: "Emergency assistant",
    instructions: buildInstructions(deps.profile),
    model: model.modelId, // provider's model ID, e.g. "gemma4-26b-a4b"
    modelSettings: {
      temperature: 0.2, // low = more consistent, less creative
      maxTokens: 600, // upper bound on answer length
      // Extra provider-specific request fields from config (e.g. OpenRouter's reasoning switch).
      providerData: model.extraRequest,
    },
    outputGuardrails: [groundingGuardrail],
  });

  // The conversation so far, then the new question (with its cards) as the last message.
  // `user()` and `assistant()` are SDK helpers that build correctly-shaped message objects.
  const userMessage = buildUserMessage(cards, req.situation, req.question);
  const input = [
    ...(req.history ?? []).map((turn) => (turn.role === "user" ? user(turn.text) : assistant(turn.text))),
    user(userMessage),
  ];

  // ----- Step 4 + 5: model call, then the output guardrail -----------------------
  const result = await runner.run(agent, input, {
    context: { providedIds: cards.map((c) => c.id), providedText: userMessage },
  });
  const tModel = performance.now();

  const answer = String(result.finalOutput ?? "").trim();

  // Collect flags from every output guardrail that ran (currently just one).
  const flags = result.outputGuardrailResults.flatMap((g) => {
    const info = g.output.outputInfo as { flags?: string[] } | undefined;
    return info?.flags ?? [];
  });

  // Shape the result for callers (and for the audit log).
  const response: AskResponse = {
    turnId,
    answer,
    cards: hits.map((hit) => ({
      id: hit.card.id,
      ref: hit.card.ref,
      kind: hit.card.kind ?? "card",
      title: hit.card.title,
      pinned: hit.pinned,
      source: hit.card.source,
    })),
    retrievalQuery: query,
    dangers: route.dangers,
    flags,
    model: { provider, logical: model.logicalName, id: model.modelId },
    timingsMs: {
      retrieval: Math.round(tRetrieval - t0),
      model: Math.round(tModel - tRetrieval),
      total: Math.round(tModel - t0),
    },
  };

  // ----- Step 6: audit log -------------------------------------------------------
  // The response plus the inputs needed to understand it later.
  writeTurn({
    ...response,
    promptVersion: PROMPT_VERSION,
    question: req.question,
    situation: req.situation,
    historyTurns: req.history?.length ?? 0,
  });

  return response;
}
