# Architecture

## Overview

```
 npm run app  ──► app/main.ts (Electron) ──► companion server + page (modules/weather-companion)
                                                └─ /api/chat ──► chat.ts ─┐
 npm run chat ──► src/chat.ts ────────────────────────────────────────────┴─► ask() in src/agent.ts ──► one Chat Completions call
                                     │                        ├─ local llama-server (127.0.0.1:8080)
                                     │                        └─ OpenRouter
                                     ├─ src/search.ts   embeddings + cosine search over data/library/
                                     ├─ data/cards/     action cards (pinned by danger rules)
                                     └─ src/profile.ts  household profile (data/profile.json)
```

One process, one language. Network calls: the model (when online) and a tiny connectivity probe.

The desktop app (`app/main.ts`) starts the companion server (`modules/weather-companion/src/server.ts`, 127.0.0.1:4317) inside Electron's main process and shows its page, `/companion`, in the window. `.env` fixes the run: `AGENT_PROVIDER` (model while online) and `AGENT_SCENARIO` (flood, fire, earthquake, outage or heat). The page shows only answers; sources, dangers, flags and timings are in the log.

### Online and offline

```
 connectivity.ts   HEAD request to the online model's server every 3 s; 2 failures = offline, 1 success = online
                   + "simulate offline" (Ctrl+Shift+O in the window)
   ├─► feed.ts     /api/feed delivers the (simulated) emergency only while online; offline = 503
   ├─► chat.ts     offline → local model; online → AGENT_PROVIDER, and a failed or slow (15 s) online call
   │               is retried on the local model
   └─► page        also watches navigator.onLine for an instant reaction when Wi-Fi goes off; shows the
                   banner, the grey card with "last update", the model badge and a note in the thread
```

The server asks the local model for one token at start and every 10 minutes (`warmLocal()` in `src/agent.ts`), so it stays loaded and the first offline answer doesn't wait for a load.

### Dictation

The page records the microphone at 16 kHz and posts the raw samples to `/api/transcribe`. `src/transcribe.ts` starts `src/transcribe-worker.ts` as a short-lived process that runs Whisper base.en (transformers.js, CPU) and exits, which returns its ~0.9 GB of working memory right away. About 0.7 s for a short sentence.

## Per question (`ask()` in `src/agent.ts`)

| Step | What happens | AI? |
| --- | --- | --- |
| 1. Search text | Short follow-ups are searched together with the previous user question | No |
| 2. Danger rules | Regular expressions (flood, gas, fire, carbon monoxide, earthquake, heat illness) pick action cards to force in | No |
| 3. Search | The question is embedded (bge-small, on CPU) and compared with every passage; top 5 | No (a small embedding model, not a language model) |
| 4. Prompt | System: rules + household profile. User: earlier turns as text, then `Cards: [C..] … [L1] heading (publisher, updated date): text …`, a one-line medical reminder, and `Question: …`. **Medical limit:** for medicines and devices the agent passes on handling guidance only (storage, temperature limits, how long they last, when to replace); for symptoms, injuries or treatment it refers to 911, a pharmacist or a doctor. No diagnoses, first aid, doses, or advice on whether to use a medicine. | No |
| 5. Model call | OpenAI Agents SDK `Agent` + `Runner`, temperature 0.2, max 600 tokens. SDK tracing is off. Provider-specific request fields (OpenRouter: `reasoning: {enabled: false}`) are added by the HTTP client, because the SDK drops a `reasoning` setting for non-OpenAI models. | **Yes** |
| 6. Answer check | Flags: no citation, citing something not shown, phone numbers or doses not in the sources. Flags are reported, never hidden, and never block the answer. | No |
| 7. Log | `logs/turns-<date>.jsonl`: question, search text, dangers, sources, flags, answer (with citation tags), timings and the full user message | No |
| Shown | The chat (app and terminal) shows only the answer, citation tags removed. Earlier turns are kept as that plain text, so old sources are never sent again. | No |

## Files

```
app/main.ts        desktop app: starts the companion server in-process and opens its page in a window
modules/weather-companion/   the companion: screen, local server, simulated feeds, connectivity, /api/chat → ask()
src/agent.ts       ask(): everything above, plus providers, rules and the system prompt
src/search.ts      embedding model + library search
src/profile.ts     loads data/profile.json and turns it into the prompt's profile lines
src/transcribe.ts  dictation: runs src/transcribe-worker.ts (Whisper) once per recording
src/chat.ts        terminal chat (/sources for debugging, /clear, /quit)
src/embed.ts       one-time: passages.jsonl → data/library/ (passages + vectors)
src/bench.ts       benchmark on data/eval/questions.json
data/cards/        action cards: verbatim official sentences from the library, shown as steps on screen (reviewed by a person)
data/eval/         benchmark questions
data/profile.json  household profile, fixed for now (fictional demo household)
data/library/      the library the app searches: passages.jsonl + vectors.bin (committed; rebuilt by npm run embed)
data/models/       embedding and speech model files (git-ignored: too big for git; downloaded on first use)
knowledge/         Python tools that collect official pages and build the library (docs/KNOWLEDGE.md)
config/            example llama-server preset
logs/              answer logs and benchmark results (git-ignored)
```
