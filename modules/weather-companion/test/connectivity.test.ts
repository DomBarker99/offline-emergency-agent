// Connectivity monitor and feed: offline only after repeated failed probes, back online on the first
// success, simulate-offline overrides everything, and the feed delivers nothing while offline.
import test from "node:test";
import assert from "node:assert/strict";
import { createConnectivityMonitor } from "../src/connectivity.ts";
import { createFeed } from "../src/feed.ts";

test("offline after two failed probes, online after one success", async () => {
  let up = true;
  const monitor = createConnectivityMonitor({ intervalMs: 60_000, failuresToGoOffline: 2, probe: async () => up });
  try {
    assert.equal((await monitor.check()).online, true);
    up = false;
    assert.equal((await monitor.check()).online, true); // one slow probe on bad Wi-Fi doesn't flip the screen
    assert.equal((await monitor.check()).online, false);
    up = true;
    assert.equal((await monitor.check()).online, true);
    monitor.setSimulatedOffline(true);
    const state = monitor.state();
    assert.equal(state.internet, true);
    assert.equal(state.online, false);
  } finally {
    monitor.stop();
  }
});

test("the feed holds the active emergency, plays the flood forward, and is silent offline", async () => {
  let up = true;
  const monitor = createConnectivityMonitor({ intervalMs: 60_000, failuresToGoOffline: 1, probe: async () => up });
  const start = Date.parse("2026-10-24T20:00:00Z");
  try {
    const flood = createFeed("flood", monitor, start);
    const first = await flood.read(start);
    const later = await flood.read(start + 10 * 60_000);
    assert.equal(first!.stage.level, 3);
    const river = (p: typeof first) => p!.latest.find((m) => m.metric === "riverLevel")!.value!;
    assert.ok(river(later) > river(first)); // the creek keeps rising, then holds
    assert.equal(flood.demoSeconds(start + 60 * 60_000), 300);
    assert.equal(createFeed("earthquake", monitor, start).demoSeconds(start + 10 * 60_000), 200); // a quake is one moment

    up = false;
    await monitor.check();
    assert.equal(await flood.read(), null);
    assert.equal((await flood.snapshot())!.hazard, "flood");
  } finally {
    monitor.stop();
  }
});
