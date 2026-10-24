import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildContext } from '../src/scenario.ts';
import { ControlSchema } from '../src/schema.ts';

test('all clock positions and both branches satisfy temporal, flood and aggregation invariants', () => {
  for (const branch of ['assisted-departure', 'shelter-assistance'] as const) {
    for (let second = 0; second <= 300; second++) {
      const c = buildContext(second, branch);
      assert.equal(c.stage.level, second < 100 ? 1 : second < 200 ? 2 : 3);
      assert.equal(c.impacts.floodingConfirmed, c.watershed.riverStage.value >= c.watershed.floodStage.value);
      assert.equal(c.weather.history.at(-1)!.end, c.asOf);
      assert.equal(c.weather.forecast.hourly[0].start, c.asOf);
      for (const [rows, summaries, future] of [[c.weather.history, c.weather.pastWindows, false], [c.weather.forecast.hourly, c.weather.forecast.upcomingWindows, true]] as const) {
        for (const w of summaries) {
          const selected = future ? rows.slice(0, w.hours) : rows.slice(-w.hours);
          assert.ok(Math.abs(w.precipitation.value - selected.reduce((s, r) => s + r.precipitation.value, 0)) < 0.011);
          assert.equal(new Set(w.evidenceIds).size, w.hours);
          assert.equal((Date.parse(w.end) - Date.parse(w.start)) / 3600000, w.hours);
        }
      }
      assert.equal(c.branch.assistanceStatus, 'not-executed');
      assert.equal(c.impacts.communications, 'available');
    }
  }
});
test('branches share weather but diverge on access during flooding', () => {
  const a = buildContext(225, 'assisted-departure');
  const b = buildContext(225, 'shelter-assistance');
  assert.deepEqual(a.weather, b.weather);
  assert.equal(a.branch.departureRouteAvailable, true);
  assert.equal(b.branch.departureRouteAvailable, false);
  assert.notEqual(a.aiHandoff.requestId, b.aiHandoff.requestId);
});
test('deterministic replay and invalid controls', () => {
  assert.deepEqual(buildContext(123), buildContext(123));
  assert.throws(() => buildContext(-1));
  assert.throws(() => buildContext(NaN));
  assert.equal(ControlSchema.safeParse({ action: 'seek' }).success, false);
  assert.equal(ControlSchema.safeParse({ action: 'seek', seconds: 301 }).success, false);
  assert.equal(ControlSchema.safeParse({ action: 'branch', branch: 'unknown' }).success, false);
});
