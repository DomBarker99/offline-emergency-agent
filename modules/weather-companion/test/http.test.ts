// The server end to end: pages, setup, the feed going offline when the internet "drops", simulate
// offline, and input checks. The internet is played by a tiny local server the test can stop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("screen, setup, live feed, offline switch and bad requests", { timeout: 60000 }, async () => {
  // Stand-in for "the internet": while it listens, the server's probe succeeds.
  const internet = createServer((_req, res) => res.end("ok"));
  internet.listen(0, "127.0.0.1");
  await once(internet, "listening");
  const internetUrl = `http://127.0.0.1:${(internet.address() as { port: number }).port}/`;

  const child = spawn(process.execPath, ["--experimental-strip-types", "src/server.ts"], {
    env: { ...process.env, PORT: "0", AGENT_SCENARIO: "flood", AGENT_PROVIDER: "openrouter", AGENT_WARM_LOCAL: "0",
           CONNECTIVITY_PROBE_URL: internetUrl, CONNECTIVITY_INTERVAL_MS: "200" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const line = await Promise.race([
      once(child.stdout, "data").then(([value]) => String(value)),
      once(child, "exit").then(([code]) => { throw Error(`Server exited: ${code}`); }),
    ]);
    const base = line.match(/http:\/\/127\.0\.0\.1:\d+/)![0];
    const get = async (path: string) => { const r = await fetch(base + path); return { status: r.status, data: await r.json() }; };
    const post = (path: string, body: unknown, headers: Record<string, string> = { "Content-Type": "application/json" }) =>
      fetch(base + path, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

    // Pages
    const page = await fetch(base + "/companion");
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Help me now/);
    for (const asset of ["/studio.js", "/vendor/gsap.min.js"]) assert.equal((await fetch(base + asset)).status, 200);
    assert.equal((await fetch(base + "/v1/context")).status, 404); // the old dashboard API is gone

    // Setup: contact from the profile, the flood card as steps, four prompts
    const setup = (await get("/api/setup")).data;
    assert.equal(setup.scenario, "flood");
    assert.equal(setup.provider, "openrouter");
    assert.deepEqual(setup.contact, { name: "Aunt Rosa", relation: "aunt", city: "Sacramento", phone: "555-0142" });
    assert.equal(setup.card.id, "C1");
    assert.ok(setup.card.steps.length >= 3 && setup.card.sources[0].url.startsWith("https://"));
    assert.equal(setup.prompts.length, 4);

    // Online: the feed delivers the active flood
    const live = await get("/api/feed");
    assert.equal(live.status, 200);
    assert.equal(live.data.packet.hazard, "flood");
    assert.equal(live.data.packet.stage.level, 3);
    assert.equal((await get("/api/status")).data.online, true);

    // The internet drops: after a couple of failed probes the server says offline and the feed stops
    internet.close();
    await wait(1200);
    const status = (await get("/api/status")).data;
    assert.equal(status.internet, false);
    assert.equal(status.online, false);
    assert.equal((await get("/api/feed")).status, 503);
    const saved = await get("/api/feed?saved=1"); // what the app shows if it starts offline
    assert.equal(saved.status, 200);
    assert.equal(saved.data.saved, true);

    // The internet comes back
    internet.listen(Number(new URL(internetUrl).port), "127.0.0.1");
    await once(internet, "listening");
    await wait(600);
    assert.equal((await get("/api/status")).data.online, true);

    // Simulate offline (the presenter key) and back
    assert.equal((await (await post("/api/simulate-offline", { offline: true })).json()).online, false);
    assert.equal((await get("/api/feed")).status, 503);
    assert.equal((await (await post("/api/simulate-offline", { offline: false })).json()).online, true);
    assert.equal((await post("/api/simulate-offline", "nonsense")).status, 400);

    // Input checks
    assert.equal((await post("/api/chat", { text: "" })).status, 400);
    assert.equal((await post("/api/chat", "x", { "Content-Type": "text/plain" })).status, 415);
    assert.equal((await post("/api/chat", {}, { "Content-Type": "application/json", Origin: "https://example.com" })).status, 403);
    assert.equal((await post("/api/transcribe", "x", { "Content-Type": "text/plain" })).status, 415);
    const tooLong = new Float32Array(16000 * 31);
    assert.equal((await fetch(base + "/api/transcribe", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: tooLong })).status, 413);
    assert.equal((await fetch(base + "/v2/context?hazard=invalid")).status, 400);
    assert.equal((await fetch(base + "/unknown")).status, 404);
  } finally {
    child.kill();
    internet.close();
    if (child.exitCode === null) await once(child, "exit");
  }
});
