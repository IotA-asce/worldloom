/**
 * The world clock (ADR-0011). Minecraft's `time_ticks` wraps every 24000 ticks
 * and can also be moved backwards by `set_time`, so the monotonic total has to
 * be derived carefully — a bug here silently rewinds the civilization's history.
 */

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  isDaylight,
  phaseOf,
  TICKS_PER_DAY,
} from '../../src/persistence/repositories/simulation.ts';
import { Store } from '../../src/persistence/store.ts';

function clockStore(): Store {
  const store = Store.openMemory();
  store.simulation.initialise('clock-test', 1, 0);
  return store;
}

describe('day phases', () => {
  it('maps Minecraft ticks onto phases', () => {
    assert.equal(phaseOf(0), 'dawn');
    assert.equal(phaseOf(6_000), 'day');       // noon
    assert.equal(phaseOf(12_000), 'dusk');     // sunset
    assert.equal(phaseOf(18_000), 'night');    // midnight
    assert.equal(phaseOf(23_999), 'night');
  });

  it('wraps rather than falling off the end', () => {
    assert.equal(phaseOf(TICKS_PER_DAY + 6_000), 'day');
    assert.equal(phaseOf(TICKS_PER_DAY * 5 + 18_000), 'night');
  });

  it('handles negative input without producing an invalid phase', () => {
    assert.equal(phaseOf(-1), 'night');
  });

  it('reports daylight for dawn and day only', () => {
    assert.ok(isDaylight(0));
    assert.ok(isDaylight(6_000));
    assert.ok(!isDaylight(12_500), 'dusk is not daylight — this is when shelter matters');
    assert.ok(!isDaylight(18_000));
  });
});

describe('monotonic clock', () => {
  it('accumulates forward movement within a day', () => {
    const store = clockStore();
    assert.equal(store.simulation.advanceClock(1_000, 'clear').totalTicks, 1_000);
    assert.equal(store.simulation.advanceClock(5_000, 'clear').totalTicks, 5_000);
    assert.equal(store.simulation.advanceClock(11_000, 'clear').totalTicks, 11_000);
    assert.equal(store.simulation.get().worldDay, 0);
    store.close();
  });

  it('advances the day when the raw clock wraps', () => {
    const store = clockStore();
    store.simulation.advanceClock(23_500, 'clear');
    assert.equal(store.simulation.get().worldDay, 0);

    // The next sample comes back at 200 — a new Minecraft day began.
    const time = store.simulation.advanceClock(200, 'clear');
    assert.equal(time.day, 1);
    // 23500 elapsed, then 500 to the wrap, then 200 into the new day.
    assert.equal(time.totalTicks, 24_200);
    store.close();
  });

  it('never runs the total backwards, even when time is set backwards', () => {
    const store = clockStore();
    store.simulation.advanceClock(20_000, 'clear');
    const before = store.simulation.get().worldTicks;

    // A scenario calling `set_time 0` looks exactly like a wrap; either way the
    // total must not decrease.
    const after = store.simulation.advanceClock(0, 'clear').totalTicks;
    assert.ok(after >= before, `total went backwards: ${before} -> ${after}`);
    store.close();
  });

  it('stays consistent across many days', () => {
    const store = clockStore();
    for (let day = 0; day < 10; day++) {
      store.simulation.advanceClock(6_000, 'clear');
      store.simulation.advanceClock(18_000, 'clear');
      store.simulation.advanceClock(23_900, 'clear');
    }
    const state = store.simulation.get();
    assert.equal(state.worldDay, 9);
    // Day and total must agree, or events land on the wrong day.
    assert.equal(Math.floor(state.worldTicks / TICKS_PER_DAY), state.worldDay);
    store.close();
  });

  it('derives the day from the total when time is scaled hard', () => {
    const store = clockStore();
    // An accelerated scenario can skip most of a day between samples.
    store.simulation.advanceClock(23_000, 'clear');
    store.simulation.advanceClock(1_000, 'clear');   // wrap -> day 1
    const state = store.simulation.get();
    assert.ok(state.worldDay >= 1);
    assert.ok(state.worldDay >= Math.floor(state.worldTicks / TICKS_PER_DAY));
    store.close();
  });

  it('tracks weather and reports the current time without re-querying', () => {
    const store = clockStore();
    store.simulation.advanceClock(6_000, 'thunder');
    const current = store.simulation.currentTime();
    assert.equal(current.weather, 'thunder');
    assert.equal(current.phase, 'day');
    assert.equal(current.totalTicks, 6_000);
    store.close();
  });

  it('survives a restart without rewinding the day', () => {
    const dir = mkdtempSync(join(tmpdir(), 'worldloom-clock-'));
    const path = join(dir, 'clock.db');

    const first = Store.open(path);
    first.simulation.initialise('clock-test', 1, 0);
    first.simulation.advanceClock(23_800, 'clear');
    first.simulation.advanceClock(400, 'rain');   // into day 1
    const beforeRestart = first.simulation.get();
    first.close();

    const second = Store.open(path);
    const afterRestart = second.simulation.get();
    assert.deepEqual(afterRestart, beforeRestart);

    // 23800 elapsed on day 0, then 600 across the wrap (200 to midnight + 400),
    // then 1000 more — the raw tick persisted as 400, so this is not a wrap.
    assert.equal(beforeRestart.worldTicks, 24_400);
    assert.equal(beforeRestart.lastRawTicks, 400);

    // Continuing from the persisted raw tick, not from zero — otherwise the
    // first post-restart sample would look like a wrap and skip a day.
    const time = second.simulation.advanceClock(1_400, 'rain');
    assert.equal(time.day, 1);
    assert.equal(time.totalTicks, 25_400);
    second.close();
  });

  it('initialise is idempotent, so a restart does not reset the run', () => {
    const store = clockStore();
    store.simulation.advanceClock(5_000, 'clear');
    const again = store.simulation.initialise('a-different-name', 999, 12345);
    assert.equal(again.scenario, 'clock-test', 'the original run metadata wins');
    assert.equal(again.seed, 1);
    assert.equal(again.worldTicks, 5_000);
    store.close();
  });
});
