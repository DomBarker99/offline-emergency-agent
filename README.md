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

Requirements: Node.js 24+ (runs TypeScript directly). The library (`data/library/`, 2,140 official passages) is in the repo. The first start downloads the small embedding model (~130 MB) and the first dictation downloads the speech model (Whisper base.en, ~77 MB) into `data/models/`; after that everything runs offline. To rebuild the library from new sources, see docs/KNOWLEDGE.md.

```sh
npm ci
cp .env.example .env                       # set AGENT_PROVIDER, AGENT_SCENARIO and (for OpenRouter) the key
npm run app                                # desktop window (Electron): the companion screen + the agent
npm run chat -- --provider openrouter      # terminal chat; or --provider local
npm run bench -- --provider openrouter     # 50 evaluation questions (add --model <name> for another model)
```

### The desktop app

It opens on an active emergency (`AGENT_SCENARIO`) with a full-window alert, then shows the emergency card, the assistant, the support contact from the profile and the official action card for that emergency.

- **Online:** the card says **Live** and updates from the emergency feed; answers come from `AGENT_PROVIDER`.
- **Offline** (Wi-Fi off, or no internet behind it): within seconds a banner appears, the card turns grey with the time of the last update, the scene freezes and answers come from the local model. If the internet drops while an online answer is on its way, the question is answered locally.
- **Ctrl+Shift+E** starts the emergency when `AGENT_START=calm` (press it while online: the alert arrives through the feed).
- **Ctrl+Shift+O** in the window simulates offline (press again to come back), for rehearsals.
- **Dictation:** the microphone button records, Whisper transcribes on the laptop, and the words appear in the message box to check before sending. macOS asks once for microphone access.

The emergency data is simulated (the screen says so); the connection check is real: the app probes the internet every 3 seconds.

### Local model

`--provider local` expects an OpenAI-compatible server at `http://127.0.0.1:8080/v1` serving a model named `gemma4-26b-a4b` (change with `LOCAL_BASE_URL`, `AGENT_LOCAL_MODEL` or `--model`). [llama.cpp](https://github.com/ggml-org/llama.cpp)'s `llama-server` works well; `config/llama-server.example.ini` is a preset:

```sh
llama-server --models-preset config/llama-server.example.ini --models-max 1
```

## Configuration (`.env`)

| Variable | Used for |
| --- | --- |
| `AGENT_PROVIDER` | `local` (default) or `openrouter`: the model the app uses while online, and the chat's default. Offline is always local. |
| `AGENT_LOCAL_MODEL` | The local model by its server name: `gemma4-26b-a4b` (default) or `granite4.2-8b` (any name your server's preset defines) |
| `AGENT_START` | `event` (default): the emergency is active at launch. `calm`: normal conditions until **Ctrl+Shift+E** starts it (alert, red card, and the assistant posts the official first steps) |
| `AGENT_SCENARIO` | The emergency the app opens on: `flood` (default), `fire`, `earthquake`, `outage`, `heat` |
| `OPENROUTER_API_KEY` | `openrouter` |
| `OPENROUTER_BASE_URL`, `LOCAL_BASE_URL` | Optional: send model calls elsewhere (e.g. through a debugging proxy) |
| `AGENT_DEVTOOLS` | `1` opens DevTools next to the app window |
| `CORPUS_DIR` | `npm run embed` default input, and the Python library tools |
| `BUILD_LLM_*` | Python library tools only (see docs/KNOWLEDGE.md) |

## License

TBD.

## Companion module

`modules/weather-companion` holds the screen and its local server: simulated flood, wildfire, earthquake, power-outage and extreme-heat feeds, the animated window, the connectivity check and the chat bridge to `src/agent.ts`.

```sh
npm run weather:install
npm run weather:test                       # module tests
npm run weather:demo                       # the same server without Electron: http://127.0.0.1:4317/companion
```

`weather:demo` doesn't read `.env`; set `AGENT_PROVIDER`, `AGENT_SCENARIO` and `OPENROUTER_API_KEY` in the shell. See [the context and harness contract](modules/weather-companion/DATA_PIPELINE.md).
