# offline-emergency-agent

A local, offline emergency response agent: an on-device model that answers from a localized, source-backed knowledge pack when power and communications are down. Built for SpartHill Hacks 2026. Planning docs live one folder up, in the `sparthill-2026` workspace.

**Status:** working scaffold. OpenAI Agents SDK agent with a deterministic safety router, keyword search over 6 DEMO cards, grounding checks and local audit logs. Terminal chat plus local HTTP API. Runs on the local llama.cpp models or OpenRouter via one config file. **Start with [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).**

## How development works

```
 Agent edits here: /shared/sparthill-2026/offline-emergency-agent   (synced to your Mac via Nextcloud, read-only view)
        │ git push
        ▼
 GitHub: DomBarker99/offline-emergency-agent (private)   ← the history; review every change here
        │ git pull
        ▼
 Mac runs it: ~/Developer/offline-emergency-agent   (dependencies installed here; talks to OpenRouter + local models)
```

- **Don't run git in the Nextcloud copy on the Mac.** Two git clients writing the same `.git` through file sync can corrupt it. Use the Mac clone for anything you run or change.
- **Dependencies are never in the synced folder.** On the agent they're installed in a mirror (`scripts/agent-check.sh`).

## Run it on the Mac

```sh
cd ~/Developer/offline-emergency-agent
git pull
npm ci                     # install exact locked dependencies
npm run typecheck
npm run chat               # needs the local server: bash <workspace>/playground/start.sh
npm run chat -- --provider openrouter   # needs OPENROUTER_API_KEY in ~/.config/sparthill/env
npm run serve              # HTTP API on 127.0.0.1:8787
```

## Configuration

| What | Where | In git? |
| --- | --- | --- |
| Logical model names mapped to provider model IDs | `config/models.json` | yes |
| Local per-model settings (thinking switch, context) | workspace `playground/models.ini` | workspace |
| Secrets (OpenRouter key) | `~/.config/sparthill/env` on the machine that runs the app (`chmod 600`) | **never** |

The app only uses logical names (`gemma-26b`, `gpt-oss-20b`, `granite-8b`). Switching between cloud and local, or between models, is a config change, not a code change.

## Requirements

Node 24 or newer, which runs TypeScript directly (no build step). npm.
