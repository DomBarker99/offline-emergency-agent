# Companion module

The desktop app's screen and its local server: simulated emergency feeds, the animated window, the online/offline switch, dictation and the chat bridge to the shared agent (`src/agent.ts` in the repo root). Everything binds to `127.0.0.1` only.

All places, people, resources, alerts and measurements in the feeds are fictional. The screen says so ("Demo scenario · not a real alert"). Nothing here contacts anyone or dispatches anything.

## Run

The desktop app (`npm run app` in the repo root) starts this server inside Electron. To run it alone:

```sh
npm ci            # in this folder (or npm run weather:install from the root)
npm test          # module tests
npm start         # http://127.0.0.1:4317/companion
```

`npm start` doesn't read `.env`: set `AGENT_SCENARIO`, `AGENT_PROVIDER` and `OPENROUTER_API_KEY` in the shell. `PORT` changes the port.

## Files

| File | Role |
| --- | --- |
| `public/companion.html` | The screen: launch alert, emergency card, assistant, support contact, official card, offline banner |
| `public/animation-studio.html`, `studio.js`, `vendor/gsap.min.js` | The animated window, embedded in the screen (`?embed=external`) |
| `src/server.ts` | Routes (listed at the top of the file and in `DATA_PIPELINE.md`) |
| `src/connectivity.ts` | Internet probe every 3 s, plus "simulate offline" |
| `src/feed.ts` | The active emergency; delivered only while online |
| `src/setup.ts` | Support contact (from the profile), the scenario's official card, Help me now prompts |
| `src/chat.ts` | Questions to `ask()`; offline goes to the local model, failed online calls fall back to it |
| `src/events/`, `src/event-pipeline.ts` | Simulated sources, Zod validation and the context processor (v2 packets) |
| `src/scenario.ts`, `src/schema.ts` | The original flood model the v2 flood feed reuses |

Data contract and the online/offline design: [DATA_PIPELINE.md](DATA_PIPELINE.md). Animation notes: [ANIMATION_GUIDE.md](ANIMATION_GUIDE.md).

## Animated window

The window uses a locally bundled **GSAP 3.13.0** and original SVG artwork, so no CDN is needed. The GSAP copyright/license header is kept in `public/vendor/gsap.min.js`; license: https://gsap.com/standard-license. The scene is illustrative: it is not a map and not evidence that a building is safe. The companion freezes and dims it while offline.
