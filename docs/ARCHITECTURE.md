# Architecture walkthrough

How the pieces fit, in plain language. Update this file whenever the structure changes.

## The big picture

```
   ┌──────────── interfaces (swappable) ────────────┐
   │ terminal chat    browser page    desktop window │
   │ src/cli/         (later)         (later)        │
   └───────┬──────────────┬──────────────┬───────────┘
           │ direct call  │ HTTP         │ HTTP
           │              ▼              ▼
           │      src/server/http.ts  (127.0.0.1:8787, POST /api/ask)
           ▼              │
   ┌──────────────────────┴────────────────────────────┐
   │ src/core/   the agent's "brain" (no UI, no HTTP)   │
   │   agent.ts  ask(): the one entry point             │
   │   safety.ts → knowledge.ts → prompt.ts → models.ts │
   │   audit.ts  (local logs)                           │
   └──────────────────────┬────────────────────────────┘
                          │ OpenAI-style API
           ┌──────────────┴──────────────┐
           ▼                             ▼
   llama-server on the Mac         OpenRouter (cloud, development only)
   (playground/models.ini)         (key in ~/.config/sparthill/env)
```

**The core idea:** all the intelligence lives in `src/core/` and is reached through one function, `ask()`. Interfaces are thin. They collect a question, call `ask()` (directly or over HTTP), and display the answer. That's why the frontend decision can wait: the core doesn't care what's on top of it.

## What happens when you ask a question

`ask()` in `src/core/agent.ts`:

| Step | File | What it does | AI involved? |
| --- | --- | --- | --- |
| 1. Safety router | `safety.ts` | Looks for danger words (rising water, gas, fire, generator indoors). If found, **pins** that scenario's "immediate" cards so they're always shown to the model. | No (plain rules) |
| 2. Knowledge search | `knowledge.ts` | Finds the cards that best match the question, up to 4. | No |
| 3. Prompt assembly | `prompt.ts` | Builds the instructions (rules + household profile) and the message (cards + situation + question). | No |
| 4. Model call | `models.ts` + Agents SDK | Sends it to the model chosen in config: local or OpenRouter. | **Yes** (the only step) |
| 5. Grounding check | `safety.ts` via an SDK output guardrail | Flags answers with no citation, citations to cards that weren't given, phone numbers or doses not in the cards. Flags are recorded, not hidden. | No |
| 6. Audit | `audit.ts` | Writes one line per question to `logs/turns-*.jsonl` and the SDK's trace to `logs/trace-*.jsonl`. **Nothing is sent to OpenAI's tracing service.** | No |

Only step 4 uses AI. Everything else is ordinary code you can read, test and change.

## The three kinds of memory, and where each lives

| Memory | What | Where now | Where next |
| --- | --- | --- | --- |
| **Knowledge** | The emergency cards | `data/demo/cards.json`, searched by simple keyword matching (`DemoKeywordStore`) | A SQLite "pack" file with full-text search (and maybe vector search). It plugs in behind the same `KnowledgeStore` interface. |
| **Profile** | Household facts, meds, meeting points | `data/demo/profile.json`, put into every prompt | Edited in the app, stored locally |
| **Situation + conversation** | What's happening now, plus prior turns | Kept by the interface and sent with each request (`history`, `situation`) | Same, plus a visible, editable "situation" panel |

**About databases, briefly:**
- **SQLite** is a database stored in one file. No server needed, works offline, easy to copy to a laptop. The knowledge pack will be one of these.
- **Full-text search** (SQLite's FTS5) finds cards by words, like a search engine.
- **Vector search** finds cards by *meaning*: "dog" matches "pet carrier." It works by turning text into lists of numbers ("embeddings") with a small model, then finding the closest ones.

The `What about the dog?` test currently fails for exactly this reason: no keyword overlap. Vector search, or smarter query handling, is how we'd fix it.

## How a desktop app would connect

Options, all compatible with this structure:

| Option | How it talks to the agent | Notes |
| --- | --- | --- |
| **Browser page** | Served by `src/server/http.ts`, calls `/api/ask` | Simplest. Opens in Safari/Chrome at `127.0.0.1`. |
| **Electron** | Its Node "main process" can start the server (or import `src/core` directly) and show the page in a window | All TypeScript, familiar tooling. Bundles its own Chromium: roughly 150 to 300 MB extra memory. |
| **Tauri** | Rust shell starts the server as a "sidecar" and shows the page in the system WebView | Much lighter on memory (uses macOS's built-in WebKit). Needs the Rust toolchain. |

Whatever we pick, the UI is the same web page, and the shell is a small wrapper added at the end. Memory matters on a 24 GB Mac running a 15 GB model, which counts in Tauri's favor or a plain browser tab's. We can decide once the UI exists.

## Folder map

```
config/models.json        logical model names → provider model IDs (local + OpenRouter)
data/demo/                DEMO cards and profile (placeholders, not vetted guidance)
docs/                     this walkthrough
scripts/agent-check.sh    agent-side install + typecheck (outside the synced folder)
scripts/setup-github.sh   one-time GitHub setup (unused; GitHub is set up from the agent)
src/core/                 the agent (see table above)
src/cli/chat.ts           terminal chat  →  npm run chat
src/server/http.ts        local HTTP API →  npm run serve
src/dev/                  low-level provider smoke test (no SDK) → npm run smoke
logs/                     audit logs (git-ignored)
```

## Commands

```sh
npm run chat                               # chat with the local default model (start the playground first)
npm run chat -- --model granite-8b         # pick a model by logical name
npm run chat -- --provider openrouter      # same agent, cloud model (needs the key)
npm run serve                              # HTTP API on 127.0.0.1:8787
npm run typecheck                          # TypeScript check
```

In chat: `/cards` shows which cards were used, `/situation <text>` adds a situation note, `/model`, `/provider`, `/clear`, `/quit`.
