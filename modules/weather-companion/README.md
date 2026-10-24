# Flood context simulator — developer handoff

This package supplies synthetic flood metrics and processed context to the application and local AI harness, with a basic live dashboard. All places, people, resources, alerts, thresholds, and measurements are fictional. It makes no external API calls or contact attempts. It does not execute a local model.

## Run

Use Node 22.18+ (or a newer release supporting TypeScript stripping).

```sh
npm ci
npm test
npm start
```

The server binds to `127.0.0.1:4317` and starts paused. Set `PORT` to change the port. Dependencies are pinned in the lockfile. No secrets or real location are required.

Open `http://127.0.0.1:4317/` for the dashboard. **Play**, **Pause**, and **Reset** sit inside the lower **Developer demo controls** disclosure; Play becomes Replay at the end. A day–night bar shows simulated time moving from midnight through dawn to noon. Its continuous motion interpolates the authoritative server clock; weather snapshots still update hourly in scenario time. The three condition states transition gently and honor reduced-motion preferences. The condition panel includes a water-level indicator on a labeled 0–5 m scale, a flood-stage marker and current reading. Its fill follows the supplied gauge reading; waves drift gently during playback and pause with the clock. Reduced-motion settings stop the wave animation. Expand **Developer demo controls** to jump to a stage or select an assistance branch. The main view updates every second from `/v1/context` and displays stage, rain, river conditions, roads, support context, quality dimensions, and the 1/4/8/12-hour rainfall table. **Local AI context** exposes the handoff summary and full JSON link; it does not display generated AI advice. Connection failures mark displayed information as potentially out of date. Synthetic-data identification remains in the footer and context details.

## Three stages

| Demo seconds | Scenario hours | Level | Meaning |
|---|---|---|---|
| 0–99 | 0–3 | 1 — steady | Normal local conditions and routine assessment |
| 100–199 | 4–7 | 2 — prepare | Worsening rain and rising river; begin mitigation |
| 200–300 | 8–12 | 3 — event | Confirmed flooding in the fictional area |

Five demo minutes represent twelve hours. Every 25 seconds advances one scenario hour and produces a new snapshot. Twelve hours of prior observations are available immediately, with twelve forecast hours ahead of every snapshot. The last frame remains in the active flood event; this demo does not imply recovery.

Stage is explicit scenario truth, not a production hazard detector. Level 3 uses confirmed flood occurrence, not a claim that forecasts are guaranteed. River discharge is a synthetic relationship, not a calibrated hydraulic model. Rainfall is liquid precipitation in this scenario, with no snow. No missing data, stale sensors, or injected failures are scripted.

## API

| Endpoint | Purpose |
|---|---|
| `GET /v1/context` | Complete application/local-model packet |
| `GET /v1/weather` | Current interval, history, forecasts, 1/4/8/12-hour aggregates |
| `GET /v1/watershed` | Gauge stage, discharge, saturation, flood stage and upstream rain |
| `GET /v1/alerts` | Clearly synthetic watch/warning lifecycle |
| `GET /v1/impacts` | Roads, electricity and communications state |
| `GET /v1/resources` | Fictional reception center and helper availability |
| `GET /v1/resident` | Minimal synthetic older-person context |
| `GET /v1/assessment` | Stage, branch and assessment request |
| `GET /health` | Server liveness |
| `GET/POST /dev/clock` | Developer-only playback and branching controls |

These are project-owned contracts, not drop-in NWS or other provider replicas. Separate product requests can straddle a clock tick: use the single `/v1/context` response when an atomic view is required. Individual product responses include `runId`, `revision`, `asOf`, area and quality for alignment.

The full packet is generated from one scenario model, then validated with Zod before delivery. `src/schema.ts` defines its contract; `src/scenario.ts` produces metrics and aggregates; `src/server.ts` serves them and owns playback. Quality is supplied as explicit dimensions, without a blended percentage. In this clean-data demo those dimensions are fixed assertions, not a general-purpose quality engine.

## Developer clock (keep out of end-user UI)

```sh
curl -X POST http://127.0.0.1:4317/dev/clock -d '{"action":"play"}'
curl -X POST http://127.0.0.1:4317/dev/clock -d '{"action":"pause"}'
curl -X POST http://127.0.0.1:4317/dev/clock -d '{"action":"seek","seconds":200}'
curl -X POST http://127.0.0.1:4317/dev/clock -d '{"action":"branch","branch":"shelter-assistance"}'
curl -X POST http://127.0.0.1:4317/dev/clock -d '{"action":"reset"}'
```

Seek and branch changes pause playback; call play to resume. Reset returns to second zero, preserving the selected branch. Reset, seek and branch changes create a new `runId`, allowing consumers to invalidate prior assessments. The clock is hidden by endpoint separation only: localhost developer controls have no authentication. Use an application backend proxy exposing only `/v1/*` to an end-user frontend. CORS is not enabled.

## Branches

- `assisted-departure`: the assistance route remains open and a fictional helper is available. Creek Road closes during flooding. The AI can evaluate departure support; the simulator never claims departure or dispatch occurred.
- `shelter-assistance`: the assistance route closes at stage 3 and the helper cannot reach the resident. Context supports assessing help while sheltering. Building layout, safe floors, rescue availability and rescue completion are unknown and must not be invented.

Weather is identical across branches. Branches describe circumstances and options, not predetermined agent success. Communications remain available in both branches. Future offline communications behavior belongs to a later extension.

## Local AI consumption

Poll `/v1/context` for this demo (one-second polling is adequate for smooth stage discovery). Request assessment on each new `(runId, revision)` if compute permits, including steady state. Deduplicate identical snapshots; this yields 13 distinct hourly frames over a full run. The demo uses fixed polling; adaptive live-provider polling is deferred.

Treat the packet as evidence. Configure model behavior in the harness: calm wording, uncertainty made explicit, no unsupported claims of safety, no invented contacts or completed actions, and no travel advice through closed roads. Suggested actions are not execution. `notificationAuthorized: false` means this packet is not permission to interrupt or contact someone; the harness/application owns that policy.

Forecasts are deliberately revised as the scenario develops. Their uncertainty is qualitative and explicitly uncalibrated. No invented forecast accuracy percentage or statistically calibrated range is supplied. Current weather is the latest completed hourly interval, not an instantaneous observation; its `start` and `end` are authoritative. Window rain totals sum nonoverlapping hourly amounts; wind means are equal-duration averages and gust summaries are maxima.

Suggested harness response fields, still a design proposal: `runId`, `revision`, `requestId`, `summary`, `evidenceIds`, `uncertainties`, `suggestedActions`. Discard responses from an old run or revision. Execute/contact flows and AI response validation are outside this package.

## Samples and verification

`samples/` contains steady, prepare, and both event branches, plus a run manifest. Unit tests check 602 clock/branch combinations for stage boundaries, rainfall aggregation, interval alignment, flood-stage consistency, branch differences and repeatability. HTTP tests verify playback and endpoint behavior.

## Scope and next work

Implemented: clean deterministic scenario, normalized endpoints, Zod context contract, weather windows, dimensional quality fields, branch context, generous AI assessment hints and hidden developer clock.

Next expansion can add spatial polygons, ensemble distributions, more gauges, resource capacity, detailed resident preferences and longer event histories after their meaning is agreed. This initial package is broad context scaffolding, not an exhaustive replica of every upstream API. No real routing, real emergency advice engine, local model, notification system, communications outage mode, production thresholds, or physical flood simulation is implemented.

## Animated outdoor window

The primary display now uses a locally bundled **GSAP 3.13.0** and an original SVG landscape in `public/scene.js`. No CDN connection is needed at presentation time. The GSAP copyright/license header is retained in `public/vendor/gsap.min.js`; license: https://gsap.com/standard-license . Installation reference: https://gsap.com/docs/v3/Installation/ .

The scene contains a cottage, layered hills, trees, flowers, clouds, sun/moon, stars, creek ripples, rain, and droplets on the glass. `weatherScene.update(context)` accepts the existing context packet; `setClock(hours)` changes the sky; `setRunning(boolean)` controls ambient motion. Rain opacity uses the latest completed hourly precipitation amount, tree movement speed uses mean wind, and creek geometry uses river stage. Cloud cover uses the scripted warning stage as an artistic cue, not a measured cloud-cover claim. The display is explicitly illustrative, not a geographic inundation map or evidence that a particular building is safe.

Ambient loops pause with playback, when the page is hidden, or when reduced motion is requested. Weather details (including the numeric water gauge) are collapsed below the main scene. The existing context API and stage semantics remain unchanged. Microphone and conversation integration are still outside this implementation.

### Shared animated window

The dashboard now embeds `/animation-studio?embed=1` through `public/scene.js`.
The same artwork and animation code power the full studio and the dashboard.
The adapter sends same-origin messages `{type: 'weather-scene', stage: 1|2|3,
running: boolean, hours: number}`. The embedded view checks parent identity,
origin and fields, and maps these messages to the flood view only. Clock updates
are limited to simulated-minute changes. Other hazards remain isolated visual
fixtures available through the lower developer-controls link; they do not alter
the API context. The studio's Pause freezes the current sequence and Replay
restarts it. Wildfire spread is a scripted 12-second sequence, not a forecast.
