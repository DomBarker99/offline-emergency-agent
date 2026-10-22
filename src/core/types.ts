/**
 * Shared data shapes used across the app.
 *
 * This file contains only TypeScript types: no logic and no SDK imports. Types disappear
 * at runtime; they exist so the editor and `npm run typecheck` catch mistakes such as a
 * misspelled field or a missing value.
 *
 * Reading order for newcomers: Card -> Profile -> Situation -> Turn -> AskRequest -> AskResponse.
 */
import type { ProviderName } from "./config.ts";

/**
 * One unit of knowledge the agent may cite, such as "what to do when you smell gas".
 * The knowledge pack is a collection of cards. The model is told to answer only from the
 * cards it is shown and to cite them by `id`, so every answer can be traced to a source.
 */
export interface Card {
  /** Stable, short ID the model cites in square brackets, e.g. "C4" -> "[C4]". */
  id: string;
  title: string;
  /** Which emergencies this card applies to, e.g. ["flood", "evacuation"]. */
  scenarios: string[];
  /**
   * How urgent the content is:
   *  - "immediate": life-safety actions. The safety router can force these into the prompt.
   *  - "urgent":    important soon (e.g. evacuation plan).
   *  - "info":      reference material (e.g. checklists).
   */
  danger: "immediate" | "urgent" | "info";
  /** The text the model reads. Keep it short and unambiguous. */
  body: string;
  /** Where the content came from, shown to the user next to the answer. */
  source: { name: string; url?: string; retrieved?: string };
  /** true = placeholder content for development, not vetted guidance. */
  demo?: boolean;
}

/**
 * "Profile memory": stable facts about the household.
 * Small enough to include in every prompt, so the model always knows who it is helping.
 */
export interface Profile {
  household: string;
  location: string;
  medications: string[];
  meetingPoints: string[];
  notes?: string[];
}

/**
 * "Situation memory": what is happening right now (e.g. "power out since 6pm").
 * The interface keeps it and sends it with each question; the user can see and edit it.
 */
export interface Situation {
  scenario?: string;
  notes: string[];
}

/**
 * "Conversation memory": one earlier message in the chat.
 * Only the plain question/answer text is kept. The cards shown for earlier questions are
 * NOT stored, which keeps the prompt small; each new question retrieves fresh cards.
 */
export interface Turn {
  role: "user" | "assistant";
  text: string;
}

/** Input to ask(), the agent's single entry point. Also the body of POST /api/ask. */
export interface AskRequest {
  question: string;
  /** Earlier turns, oldest first. Omit for a fresh conversation. */
  history?: Turn[];
  situation?: Situation;
  /** Defaults to "local". */
  provider?: ProviderName;
  /** Logical model name from config/models.json. Defaults to its `defaultModel`. */
  model?: string;
}

/** Output of ask(). Also the JSON returned by POST /api/ask. */
export interface AskResponse {
  /** Unique ID for this question; matches the line written to the audit log. */
  turnId: string;
  answer: string;
  /** Cards shown to the model, in order. `pinned` = forced in by the safety router. */
  cards: { id: string; title: string; pinned: boolean; source: Card["source"] }[];
  /** Danger rules that matched the question, e.g. ["flood"]. */
  dangers: string[];
  /** Problems found in the answer by the grounding check, e.g. ["no-citation"]. Empty = none. */
  flags: string[];
  model: { provider: ProviderName; logical: string; id: string };
  /** Where the time went: card search vs model call. */
  timingsMs: { retrieval: number; model: number; total: number };
}
