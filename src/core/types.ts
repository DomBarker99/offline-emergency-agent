// Shared data shapes. Plain data only: no behavior, no SDK types.
import type { ProviderName } from "./config.ts";

/** One unit of knowledge the agent may cite. The knowledge pack is a collection of these. */
export interface Card {
  id: string; // stable ID the model cites, e.g. "C4"
  title: string;
  scenarios: string[]; // e.g. ["flood", "evacuation"]
  danger: "immediate" | "urgent" | "info"; // "immediate" cards can be pinned by the safety router
  body: string;
  source: { name: string; url?: string; retrieved?: string };
  demo?: boolean; // true = placeholder content, not vetted guidance
}

/** Profile memory: stable facts about the household. Small, so it goes into every prompt. */
export interface Profile {
  household: string;
  location: string;
  medications: string[];
  meetingPoints: string[];
  notes?: string[];
}

/** Situation memory: what is happening right now. Visible to and editable by the user. */
export interface Situation {
  scenario?: string;
  notes: string[];
}

/** Conversation memory: prior turns, as plain text (retrieved cards are NOT stored here). */
export interface Turn {
  role: "user" | "assistant";
  text: string;
}

export interface AskRequest {
  question: string;
  history?: Turn[];
  situation?: Situation;
  provider?: ProviderName;
  model?: string; // logical model name from config/models.json
}

export interface AskResponse {
  turnId: string;
  answer: string;
  cards: { id: string; title: string; pinned: boolean; source: Card["source"] }[];
  dangers: string[]; // safety-router matches, e.g. ["flood"]
  flags: string[]; // output checks, e.g. ["no-citation"]
  model: { provider: ProviderName; logical: string; id: string };
  timingsMs: { retrieval: number; model: number; total: number };
}
