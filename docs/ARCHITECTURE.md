# Architecture

## Overview

```
 npm run app  ──► app/main.ts (Electron) ─┐
 npm run chat ──► src/chat.ts ────────────┴─► ask() in src/agent.ts ──► one Chat Completions call
                                     │                        ├─ local llama-server (127.0.0.1:8080)
                                     │                        └─ OpenRouter
                                     ├─ src/search.ts   embeddings + cosine search over data/library/
                                     ├─ data/cards/     action cards (pinned by danger rules)
                                     └─ data/demo/profile.json   household profile
```

One process, one language. No servers of its own: the only network call is to the model.

The desktop app runs `ask()` inside Electron's main process. The window (`app/index.html`, `app/renderer.js`) reaches it only through `window.agent.ask(question, history, provider)` and `window.agent.info()`, exposed by `app/preload.cjs`, with context isolation and sandbox on. The window is a stand-in for the real frontend: a replacement only needs to call those two functions.

## Per question (`ask()` in `src/agent.ts`)

| Step | What happens | AI? |
| --- | --- | --- |
| 1. Search text | Short follow-ups are searched together with the previous user question | No |
| 2. Danger rules | Regular expressions (flood, gas, fire, carbon monoxide, earthquake, heat illness) pick action cards to force in | No |
| 3. Search | The question is embedded (bge-small, on CPU) and compared with every passage; top 5 | No (a small embedding model, not a language model) |
| 4. Prompt | System: rules + household profile. User: earlier turns as text, then `Cards: [C..] … [L1] heading (publisher, updated date): text … Question: …` | No |
| 5. Model call | OpenAI Agents SDK `Agent` + `Runner`, temperature 0.2, max 600 tokens. SDK tracing is off. | **Yes** |
| 6. Answer check | Flags: no citation, citing something not shown, phone numbers or doses not in the sources. Flags are reported, never hidden, and never block the answer. | No |
| 7. Log | `logs/turns-<date>.jsonl`: question, search text, dangers, sources, flags, answer, timings and the full user message | No |

## Files

```
app/               desktop app: main.ts (Electron main process), preload.cjs (bridge), index.html + renderer.js (window)
src/agent.ts       ask(): everything above, plus providers, rules and the system prompt
src/search.ts      embedding model + library search
src/chat.ts        terminal chat (/sources, /clear, /quit)
src/embed.ts       one-time: passages.jsonl → data/library/ (passages + vectors)
src/bench.ts       benchmark on data/eval/questions.json
data/cards/        action cards drafted from the library (reviewed by a person)
data/eval/         benchmark questions
data/demo/         household profile (placeholder)
data/library/      runtime library (git-ignored, built by npm run embed)
data/models/       embedding model files (git-ignored, downloaded by npm run embed)
knowledge/         Python tools that collect official pages and build the library (docs/KNOWLEDGE.md)
config/            example llama-server preset
logs/              answer logs and benchmark results (git-ignored)
```
