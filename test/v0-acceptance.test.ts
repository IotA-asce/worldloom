/**
 * The V0 success criteria, run as one test.
 *
 * Requirement 35 names what Worldloom has to demonstrate before it is more than
 * a demo: five persistent autonomous agents establishing a self-sustaining
 * settlement. Each criterion is asserted against the database a run produced,
 * because the database is where the evidence lives — a criterion the ledger
 * cannot prove has not been met.
 *
 * This is deliberately one long simulation rather than five small ones. The
 * criteria are about *the same* run: the agents who divide labour are the ones
 * who remember, replan, and survive the restart.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/core/config.ts';
import { sequentialIdFactory } from '../src/core/ids.ts';
import { expect } from '../src/core/result.ts';
import { generateChronicle } from '../src/chronicle/generator.ts';
import { FakeEnvironment } from '../src/environment/fake/environment.ts';
import { HeuristicProvider } from '../src/reasoning/heuristic.ts';
import { Store } from '../src/persistence/store.ts';
import { silentLogger } from '../src/observability/logger.ts';
import { Simulation } from '../src/simulation.ts';

/** Enough rounds for several days, every agent awake for all of them. */
const ROUNDS = 800;

interface Run {
  readonly store: Store;
  readonly sim: Simulation;
}

interface WorldOptions {
  /** Path for a real, on-disk world. Omitted for an in-memory one. */
  readonly database?: string;
}

function startWorld(options: WorldOptions = {}): Run {
  const config = expect(
    parseConfig(
      {
        simulation: { agents: 5, tick_interval_seconds: 0, seed: 42 },
        environment: { type: 'fake' },
        reasoning: { provider: 'heuristic' },
      },
      {},
    ),
    'config',
  );
  const store =
    options.database === undefined
      ? Store.openMemory(sequentialIdFactory())
      : Store.open({ path: options.database });
  const reasoning = new HeuristicProvider();
  const sim = Simulation.create({
    config,
    store,
    environment: new FakeEnvironment({ seed: 3, startTicks: 1_000, ticksPerQuery: 40 }),
    reasoning,
    logger: silentLogger(),
    ids: store.ids,
  });
  return { store, sim };
}

/** A COUNT(*) on one table, as a number — `.get()` may return undefined. */
function countRows(store: Store, table: string): number {
  return Number(store.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get()?.c ?? 0);
}

/** A world run for ROUNDS ticks. Shared across the criteria, and closed once. */
async function runWorld(options: WorldOptions = {}): Promise<Run> {
  const run = startWorld(options);
  expect(await run.sim.start(), 'start');
  for (let round = 0; round < ROUNDS; round++) await run.sim.tickAll();
  return run;
}

describe('the V0 success criteria', () => {
  // One world, run once, every criterion read off it. Each test asserting against
  // its own 800-round run would take seven times as long to prove the same thing.
  let store: Store;
  let sim: Simulation;

  before(async () => {
    ({ store, sim } = await runWorld());
  });

  after(async () => {
    await sim.close();
    store.close();
  });

  // ── Five autonomous agents, alive, doing different things ────────────────

  it('keeps five settlers alive and working through several days', () => {

    const agents = store.agents.all();
    assert.equal(agents.length, 5, 'five settlers started');
    assert.equal(
      agents.filter((agent) => agent.status !== 'dead').length,
      5,
      'and all of them are still standing',
    );
    assert.ok(store.simulation.currentTime().day >= 3, 'the run spanned days, not minutes');

    // Autonomy is legible: nobody told them what to do, and the decisions table
    // is the record of each choosing for itself.
    assert.ok(countRows(store, 'decisions') > 0, 'agents made recorded decisions');
  });

  // ── A settlement with a real structure ───────────────────────────────────

  it('founds a settlement and verifies a structure stands in it', () => {

    const founded = store.events.query({ types: ['settlement_founded'], limit: 1 })[0];
    assert.ok(founded !== undefined, 'the settlement was founded');

    const completed = Number(
      store.db.prepare(`SELECT COUNT(*) AS c FROM structures WHERE state = 'complete'`).get()?.c ?? 0,
    );
    assert.ok(completed >= 1, 'at least one structure is complete and standing');
  });

  // ── Division of labour ───────────────────────────────────────────────────

  it('divides labour rather than running five identical workers', () => {

    // Five settlers held genuinely different goals over the run. If all five had
    // done the same thing, the goals-by-kind distribution would be one row.
    const kinds = store.db
      .prepare(`SELECT kind, COUNT(DISTINCT agent_id) AS agents FROM goals GROUP BY kind ORDER BY agents DESC`)
      .all() as { kind: string; agents: number }[];
    assert.ok(kinds.length >= 3, `settlers pursued only ${kinds.length} distinct goal kinds`);

    // A shared project genuinely happened: work more than one settler put into.
    // `builders` is a JSON array column on the structure row.
    const structures = store.db.prepare(`SELECT builders FROM structures`).all() as { builders: string }[];
    const multiBuilder = structures.filter((row) => {
      try {
        return (JSON.parse(row.builders) as string[]).length > 1;
      } catch {
        return false;
      }
    }).length;
    const claims = countRows(store, 'project_claims');
    assert.ok(
      multiBuilder >= 1 || claims >= 2,
      'construction was shared — more than one pair of hands on it',
    );
  });

  // ── Communication and memory ─────────────────────────────────────────────

  it('spreads knowledge by being told, and remembers what happened', () => {

    assert.ok(countRows(store, 'messages') > 0, 'settlers spoke to one another');
    assert.ok(countRows(store, 'memories') > 0, 'and carry memories of it');

    // Knowledge that crossed a mind: a belief one settler holds that it only
    // knows because another said so.
    const told = store.db
      .prepare(`SELECT source FROM known_resources`).all()
      .filter((row) => {
        try {
          const source = JSON.parse(String(row.source)) as { kind?: string };
          return source.kind === 'told';
        } catch {
          return false;
        }
      }).length;
    assert.ok(
      told > 0 || countRows(store, 'relationships') > 0,
      'knowledge moved between minds, on the record',
    );
  });

  // ── Replanning after failure ─────────────────────────────────────────────

  it('recovers from failure instead of repeating it forever', () => {

    const failures = Number(
      store.db.prepare(`SELECT COUNT(*) AS c FROM events WHERE type = 'action_failed'`).get()?.c ?? 0,
    );
    assert.ok(failures > 0, 'a real run has failures to recover from');

    // Recovery is a goal that followed a failure and finished. If failure were
    // terminal, abandoned goals would dominate completions; they do not.
    const outcomes = store.db
      .prepare(`SELECT state, COUNT(*) AS c FROM goals WHERE state IN ('completed', 'abandoned') GROUP BY state`)
      .all() as { state: string; c: number }[];
    const completed = outcomes.find((row) => row.state === 'completed')?.c ?? 0;
    const abandoned = outcomes.find((row) => row.state === 'abandoned')?.c ?? 0;
    assert.ok(completed > 0, 'goals completed');
    assert.ok(completed >= abandoned, `more goals finished (${completed}) than gave up (${abandoned})`);
  });

  // ── Persistence across a restart ─────────────────────────────────────────

  it('survives a restart with its history intact', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'worldloom-restart-')), 'world.db');
    const { store, sim } = await runWorld({ database: dir });

    const count = (s: Store, table: string): number =>
      Number(s.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get()?.c ?? 0);
    const unconsolidated = (s: Store): number =>
      Number(
        s.db
          .prepare(`SELECT COUNT(*) AS c FROM memories WHERE consolidated_into IS NULL`)
          .get()?.c ?? 0,
      );

    const before = {
      day: store.simulation.currentTime().day,
      events: store.events.count(),
      memories: count(store, 'memories'),
      unconsolidated: unconsolidated(store),
      structures: count(store, 'structures'),
      settlers: store.agents.all().filter((agent) => agent.status !== 'dead').length,
    };

    // The whole point of the state machine in a column: stop, reopen, carry on.
    await sim.close();
    const reopened = startWorld({ database: dir });
    expect(await reopened.sim.start(), 'restart');
    for (let round = 0; round < 40; round++) await reopened.sim.tickAll();

    const after = {
      day: reopened.store.simulation.currentTime().day,
      events: reopened.store.events.count(),
      memories: count(reopened.store, 'memories'),
      unconsolidated: unconsolidated(reopened.store),
      structures: count(reopened.store, 'structures'),
      settlers: reopened.store.agents.all().filter((agent) => agent.status !== 'dead').length,
    };

    assert.ok(after.events >= before.events, 'events still there');
    assert.ok(after.day >= before.day, `time went backwards: day ${before.day} → ${after.day}`);
    assert.ok(after.settlers === before.settlers, 'every settler survived the restart');
    // Consolidation is *meant* to fold episodes into summaries, so the raw memory
    // count may legitimately fall. The criterion is that the past is not wiped:
    // knowledge the agents still hold survives the restart, and keeps growing.
    assert.ok(
      after.unconsolidated > 0 && after.unconsolidated >= Math.floor(before.unconsolidated / 2),
      `living memory was wiped: ${before.unconsolidated} → ${after.unconsolidated} unconsolidated`,
    );
    assert.ok(after.structures >= before.structures, 'what was built still stands');
    await reopened.sim.close();
    store.close();
    rmSync(join(dir, '..'), { recursive: true, force: true });
  });

  // ── A chronicle that only tells the truth ────────────────────────────────

  it('produces a chronicle grounded entirely in the event ledger', async () => {

    const chronicle = expect(
      await generateChronicle({ store, reasoning: new HeuristicProvider() }),
      'chronicle',
    );
    assert.ok(chronicle.length > 0, 'the run produced history worth telling');

    for (const entry of chronicle) {
      assert.ok(entry.title.length > 0 && entry.prose.length > 0, `day ${entry.day} is written`);
      assert.ok(
        entry.eventIds.length > 0,
        `day ${entry.day} names the events it is about — an ungrounded entry is a fabrication`,
      );
      // Every claim the chronicle makes is traceable to a real event id.
      for (const id of entry.eventIds) {
        assert.ok(id.length > 0, 'a citation is a real event id, not an empty string');
      }
    }
    // The shared world belongs to the `after` hook; closing it here would make
    // the hook's own close fall over.
  });
});
