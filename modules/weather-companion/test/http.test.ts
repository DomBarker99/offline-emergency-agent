import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('HTTP context, branching, clock controls and bad requests', { timeout: 10000 }, async () => {
  const child = spawn(process.execPath, ['--experimental-strip-types', 'src/server.ts'], {
    env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const line = await Promise.race([
      once(child.stdout, 'data').then(([value]) => String(value)),
      once(child, 'exit').then(([code]) => { throw Error(`Server exited: ${code}`); }),
    ]);
    const base = line.match(/http:\/\/127\.0\.0\.1:\d+/)![0];
    const dashboard = await fetch(base + '/');
    assert.equal(dashboard.status, 200);
    assert.match(dashboard.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await dashboard.text(), /Developer demo controls/);
    for (const asset of ['/scene.js', '/vendor/gsap.min.js']) {
      const response = await fetch(base + asset);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /javascript/);
      assert.ok((await response.text()).length > 1000);
    }
    const get = async (path: string) => (await fetch(base + path)).json();
    const control = async (body: unknown) => fetch(base + '/dev/clock', { method: 'POST', body: JSON.stringify(body) });
    for(const hazard of ['flood','fire','earthquake','outage','heat']) {
      const packet=await get('/v2/context?hazard='+hazard+'&seconds=200');
      assert.equal(packet.hazard,hazard);assert.equal(packet.stage.level,3);
      assert.equal(packet.schemaVersion,'2.0.0');assert.ok(packet.records.length>0);
    }
    assert.equal((await fetch(base+'/v2/context?hazard=invalid')).status,400);
    assert.equal((await fetch(base+'/v2/context?seconds=-1')).status,400);
    const companion=await fetch(base+'/companion');
    assert.equal(companion.status,200);
    assert.match(await companion.text(),/assistant:message/);
    const initial = await get('/v1/context');
    assert.equal(initial.stage.level, 1);
    assert.equal(initial.seconds, undefined);
    await control({ action: 'seek', seconds: 100 });
    assert.equal((await get('/v1/context')).stage.level, 2);
    await control({ action: 'seek', seconds: 200 });
    await control({ action: 'branch', branch: 'shelter-assistance' });
    const event = await get('/v1/context');
    assert.equal(event.stage.level, 3);
    assert.equal(event.branch.departureRouteAvailable, false);
    assert.notEqual(initial.runId, event.runId);
    assert.equal((await get('/v1/weather')).revision, event.revision);
    assert.equal((await control({ action: 'seek', seconds: -1 })).status, 400);
    assert.equal((await fetch(base + '/unknown')).status, 404);
    await control({ action: 'reset' });
    assert.equal((await get('/v1/context')).stage.level, 1);
    await control({ action: 'play' });
    assert.equal((await get('/dev/clock')).running, true);
    await control({ action: 'pause' });
    assert.equal((await get('/dev/clock')).running, false);
  } finally {
    child.kill();
    if (child.exitCode === null) await once(child, 'exit');
  }
});
