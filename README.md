# offline-emergency-agent

An offline emergency response assistant. A small on-device language model answers from a localized, source-backed knowledge pack, so people get specific guidance when power and communications are down.

Built for SpartHill Hacks 2026 (AI for Sustainable Impact).

> **Status: early prototype.** The cards in `data/demo/` are placeholders, not vetted emergency guidance. This is not an emergency service.

## How it works

Every question goes through six steps:

1. **Safety router (plain rules).** Danger words such as rising water, gas or fire pin the matching "immediate action" cards.
2. **Knowledge search.** Picks the most relevant cards.
3. **Prompt assembly.** Combines rules, household profile, cards and question.
4. **Model call** via the [OpenAI Agents SDK](https://github.com/openai/openai-agents-js), to any OpenAI-compatible endpoint (a local model server, or OpenRouter).
5. **Grounding check.** Flags answers that cite no card, or that contain numbers or doses not found in the cards.
6. **Local audit log.** One JSON line per question in `logs/`. Tracing is local only.

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quick start

Requirements: Node.js 24+ (runs TypeScript directly) and an OpenAI-compatible model endpoint.

```sh
npm ci
cp .env.example .env        # add OPENROUTER_API_KEY to use OpenRouter
npm run chat                # terminal chat, local provider by default
npm run chat -- --provider openrouter --model gemma-26b
npm run serve               # HTTP API on 127.0.0.1:8787 (POST /api/ask)
npm run typecheck
```

### Local models

The `local` provider expects an OpenAI-compatible server at `http://127.0.0.1:8080/v1`. Override it with `LOCAL_BASE_URL`. [llama.cpp](https://github.com/ggml-org/llama.cpp)'s `llama-server` in router mode works well. `config/llama-server.example.ini` is a preset for the models below:

```sh
llama-server --models-preset config/llama-server.example.ini --models-max 1
```

## Configuration

| File | Purpose |
| --- | --- |
| `config/models.json` | Logical model names (`gemma-26b`, `gpt-oss-20b`, `granite-8b`) mapped to each provider's model ID. The code only uses logical names. |
| `config/llama-server.example.ini` | Example llama-server preset with per-model settings (e.g. turning reasoning off) |
| `.env` (from `.env.example`, git-ignored) | API keys and endpoint overrides |

## License

TBD.
