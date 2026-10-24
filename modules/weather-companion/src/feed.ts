/**
 * The emergency feed: the current state of the emergency, as an online alert service would send it.
 *
 *   companion.html asks GET /api/feed every few seconds
 *        └─► server.ts ──► feed.read()
 *                            online  → the latest simulated packet (from event-pipeline.ts)
 *                            offline → null, so the page keeps showing the last packet it received
 *
 * The content is simulated, the connection is real: updates only arrive while connectivity.ts can reach
 * the internet. That makes the offline moment honest: cut the internet and the readings really stop.
 *
 * Always the active emergency ("event" stage). The scenario plays forward one simulated hour every
 * HOUR_EVERY_MS of real time, then holds on the last hour. For a flood that means the creek keeps rising
 * for a couple of minutes (3.4 m up to 4.2 m), so "Live · updated 4 s ago" visibly brings new numbers.
 * An earthquake stays on the hour it was detected (a quake is one moment, not a rising series).
 */
import { simulateEvent, type Hazard } from "./event-pipeline.ts";
import type { ConnectivityMonitor } from "./connectivity.ts";

// Demo seconds 200 to 300 are the event stage in the scenario (25 demo seconds = 1 simulated hour).
const EVENT_START = 200;
const EVENT_END = 300;
const HOUR_EVERY_MS = 30_000;

export function createFeed(scenario: Hazard, monitor: ConnectivityMonitor, startedAt = Date.now()) {
  /** Where in the event stage the scenario is right now, in demo seconds. */
  function demoSeconds(now = Date.now()): number {
    if (scenario === "earthquake") return EVENT_START;
    const hours = Math.max(0, Math.floor((now - startedAt) / HOUR_EVERY_MS));
    return Math.min(EVENT_END, EVENT_START + hours * 25);
  }

  return {
    scenario,
    demoSeconds,
    /**
     * The latest packet, or null while offline (no internet, or "Simulate offline").
     * The packet is validated by the event pipeline's Zod schema before it's returned.
     */
    async read(now = Date.now()) {
      if (!monitor.state().online) return null;
      return simulateEvent({ hazard: scenario, seconds: demoSeconds(now) });
    },
    /** The same packet regardless of connectivity: what the app saved before going offline, at first launch. */
    async snapshot(now = Date.now()) {
      return simulateEvent({ hazard: scenario, seconds: demoSeconds(now) });
    },
  };
}
