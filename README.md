# offline-emergency-agent

An offline emergency response assistant. A language model on the laptop answers from a library of official emergency guidance (FEMA, CDC, NWS, FDA, Cal OES and others), cites its sources, and works with no internet.

Built for SpartHill Hacks 2026 (AI for Sustainable Impact).

> **Status: prototype.** The library holds word-for-word official guidance, but the action cards drafted from it are not yet reviewed. This is not an emergency service.

## How it works

One TypeScript program. For each question (`src/agent.ts`):

1. **Follow-ups:** a short follow-up ("What about the dog?") is searched together with the previous question.
2. **Danger rules:** words like "flooding" or "smell gas" force that danger's action card into the answer.
3. **Search:** the 5 library passages closest in meaning, found on-device (`src/search.ts`).
4. **Prompt:** rules and household profile, then cards, passages and the question.
5. **Model call:** [OpenAI Agents SDK](https://github.com/openai/openai-agents-js) to a local model server or OpenRouter.
6. **Answer check:** flags missing citations and phone numbers or doses not found in the sources.
7. **Log:** one JSON line per question in `logs/`, including the full prompt.

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). How the library is built: [docs/KNOWLEDGE.md](docs/KNOWLEDGE.md).

## Quick start

Requirements: Node.js 24+ (runs TypeScript directly).

```sh
npm ci
cp .env.example .env                       # add OPENROUTER_API_KEY to use OpenRouter
npm run embed -- path/to/passages.jsonl    # once: builds data/library/ (downloads a ~130 MB model the first time)
npm run app                                # desktop window (Electron)
npm run chat -- --provider openrouter      # terminal chat; or --provider local
npm run bench -- --provider openrouter     # 50 evaluation questions
```

### Local model

`--provider local` expects an OpenAI-compatible server at `http://127.0.0.1:8080/v1` serving a model named `gemma4-26b-a4b` (change with `LOCAL_BASE_URL` and `--model`). [llama.cpp](https://github.com/ggml-org/llama.cpp)'s `llama-server` works well; `config/llama-server.example.ini` is a preset:

```sh
llama-server --models-preset config/llama-server.example.ini --models-max 1
```

## Configuration (`.env`)

| Variable | Used for |
| --- | --- |
| `OPENROUTER_API_KEY` | `--provider openrouter` |
| `AGENT_PROVIDER` | `local` (default) or `openrouter`: which model the app and chat use. Fixed for a run. |
| `OPENROUTER_BASE_URL`, `LOCAL_BASE_URL` | Optional: send model calls elsewhere (e.g. through a debugging proxy) |
| `AGENT_DEVTOOLS` | `1` opens DevTools next to the app window |
| `CORPUS_DIR` | `npm run embed` default input, and the Python library tools |
| `BUILD_LLM_*` | Python library tools only (see docs/KNOWLEDGE.md) |

## License

TBD.

## Weather companion demo

A separate module provides simulated flood, wildfire, earthquake, power-outage and extreme-heat context, with a responsive animated companion UI.

```sh
npm run weather:install
npm run weather:demo
# Open http://127.0.0.1:4317/companion
npm run weather:test
```

Demo controls include three event stages and an offline transition. This module supplies validated context and browser handoff events; it is not yet wired to the agent in `src/agent.ts`. Voice, local model activation, and offline reload caching remain integration work. See [the context and harness contract](modules/weather-companion/DATA_PIPELINE.md).
