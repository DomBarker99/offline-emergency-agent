# Architecture

## Overview

```
   ┌──────────── interfaces ─────────────┐
   │ terminal chat        HTTP API        │
   │ src/cli/chat.ts      src/server/     │
   └───────┬──────────────────┬───────────┘
           │ direct call      │ POST /api/ask
           ▼                  ▼
   ┌──────────────────────────────────────────────────┐
   │ src/core/   agent logic (no UI, no HTTP)          │
   │   agent.ts  ask(): the single entry point         │
   │   safety.ts → knowledge.ts → prompt.ts → models.ts│
   │   audit.ts  local logs                            │
   └──────────────────────┬───────────────────────────┘
                          │ OpenAI-compatible Chat Completions
           ┌──────────────┴──────────────┐
           ▼                             ▼
   local model server              OpenRouter
   (e.g. llama.cpp llama-server)   (cloud)
```

All agent logic lives in `src/core/` behind one function, `ask()`. Interfaces only collect input, call `ask()` (directly or over HTTP) and render the result. A browser or desktop UI would use the same HTTP API.

## Request flow

`ask()` in `src/core/agent.ts`:

| Step | File | What it does | AI? |
| --- | --- | --- | --- |
| 1. Safety router | `safety.ts` | Detects danger words (rising water, gas, fire, fuel-burning appliances indoors, earthquake, heat illness) and pins that scenario's `immediate` cards | No |
| 2. Knowledge search | `knowledge.ts`, `knowledge-cognee.ts`, `stores.ts` | Returns pinned cards, then the best-matching cards or library passages (up to 5). Short follow-ups are searched together with the previous question. | No |
| 3. Prompt assembly | `prompt.ts` | Instructions (rules + household profile) and message (cards + situation + question) | No |
| 4. Model call | `models.ts`, Agents SDK | Runs the agent on the provider and model chosen in `config/models.json` | Yes |
| 5. Grounding check | `safety.ts` (output guardrail) | Flags missing or unknown citations, phone numbers and doses not present in the cards. Flags are returned, never hidden. | No |
| 6. Audit | `audit.ts` | Appends to `logs/turns-*.jsonl`. SDK trace spans go to `logs/trace-*.jsonl`. The default remote trace exporter is replaced. | No |

## Memory

| Kind | Contents | Current implementation | Planned |
| --- | --- | --- | --- |
| Knowledge | Official library passages and action cards | `KNOWLEDGE_BACKEND=cognee`: a static Cognee pack searched by `knowledge/serve.py` (see [KNOWLEDGE.md](KNOWLEDGE.md)). `KNOWLEDGE_BACKEND=demo` (default): `data/demo/cards.json` with keyword ranking. Both sit behind the `KnowledgeStore` interface. | County and city sources, other languages |
| Profile | Household facts, medications, meeting points | `data/demo/profile.json`, included in every prompt | Editable in the app, stored locally |
| Situation and conversation | Current situation notes, prior turns | Sent by the interface with each request | Situation panel in the UI |

The demo keyword search has no notion of meaning. The Cognee backend adds meaning (vector) search and graph search, and both backends search short follow-ups ("what about the dog?") together with the previous question.

## Interfaces

- **Terminal chat** (`npm run chat`) calls `ask()` in-process. Commands: `/cards`, `/situation <text>`, `/model <name>`, `/provider <local|openrouter>`, `/clear`, `/quit`.
- **HTTP API** (`npm run serve`) binds to `127.0.0.1:8787`:
  - `GET /api/health`
  - `GET /api/models`
  - `POST /api/ask` with `{ question, history?, situation?, provider?, model? }`
- **Graphical UI:** not built yet. Any web UI (in a browser, or wrapped in a desktop shell) would call the HTTP API.

## Layout

```
config/models.json               logical model names → provider model IDs
config/llama-server.example.ini  example local model server preset
data/demo/                       placeholder cards and profile
data/cards/                      action cards drafted from the library (reviewed by a person)
data/eval/                       benchmark questions
data/pack/                       built knowledge packs (git-ignored)
knowledge/                       Python: collect, extract, build the pack, search service (see KNOWLEDGE.md)
docs/                            documentation
src/core/                        agent logic
src/cli/chat.ts                  terminal chat
src/server/http.ts               local HTTP API
src/dev/                         provider smoke test (npm run smoke), benchmark (npm run bench)
logs/                            audit logs (git-ignored)
```
