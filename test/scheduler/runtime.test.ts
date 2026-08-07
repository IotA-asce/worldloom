/**
 * The scheduler's three promises (ADR-0005): a slow agent doesn't stall the
 * others, an agent never ticks twice at once, and no agent permanently gets
 * first pick.
 *
 * These are behavioural claims about concurrency, so they are asserted against
 * deliberately staggered async delays rather than against the real tick — which
 * is exactly why the scheduler takes a tick function.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AgentId } from '../../src/core/ids.ts';
import { createRng, type Rng } from '../../src/core/rng.ts';
import { fail, ok, type Result } from '../../src/core/result.ts';
import { Scheduler, successes } from '../../src/scheduler/runtime.ts';

function agentIds(count: number): AgentId[] {
  return Array.from({ length: count }, (_, i) => `agent_${String(i)}` as AgentId);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * An RNG that leaves the rotation alone. Fairness is tested separately; a test
 * about what happens to a *particular* slow agent needs to know which one it is.
 */
function unshuffledRng(): Rng {
  return { ...createRng(1), shuffle: <T>(items: readonly T[]): T[] => [...items] };
}

describe('a slow agent does not hold up the others', () => {
  it('lets every fast tick finish while the slow one is still running', async () => {
    const [slow, ...fast] = agentIds(5);
    const delays = new Map<AgentId, number>([
      [slow!, 250],
      ...fast.map((id) => [id, 20] as const),
    ]);

    let slowRunning = false;
    /** Fast agents that finished while the slow one was still parked. */
    const finishedDuringSlowTick: AgentId[] = [];

    const scheduler = new Scheduler<string>({
      agents: () => [slow!, ...fast],
      maxConcurrency: 3,
      rng: unshuffledRng(),
      tick: async (agentId): Promise<Result<string>> => {
        if (agentId === slow) slowRunning = true;
        await sleep(delays.get(agentId) ?? 0);
        if (agentId === slow) slowRunning = false;
        else if (slowRunning) finishedDuringSlowTick.push(agentId);
        return ok(`ticked ${agentId}`);
      },
    });

    const report = await scheduler.runRound();

    assert.equal(report.outcomes.length, 5, 'every agent gets a turn');
    assert.equal(successes(report).length, 5);
    assert.deepEqual(
      new Set(finishedDuringSlowTick),
      new Set(fast),
      'all four fast agents should have completed while the slow one was waiting',
    );
    // The round costs roughly its slowest tick, not the sum of all of them.
    assert.ok(
      report.durationMs < 250 + 4 * 20,
      `round took ${report.durationMs}ms; a sequential loop would take ~330ms`,
    );
  });

  it('never runs more ticks at once than the concurrency cap allows', async () => {
    let concurrent = 0;
    let observedPeak = 0;

    const scheduler = new Scheduler<null>({
      agents: () => agentIds(8),
      maxConcurrency: 3,
      rng: createRng(2),
      tick: async () => {
        concurrent += 1;
        observedPeak = Math.max(observedPeak, concurrent);
        await sleep(10);
        concurrent -= 1;
        return ok(null);
      },
    });

    const report = await scheduler.runRound();

    assert.equal(observedPeak, 3, 'three in flight, never four');
    assert.equal(report.peakConcurrency, 3);
    assert.equal(report.outcomes.length, 8);
  });

  it('degrades to a sequential loop when the cap is one', async () => {
    let concurrent = 0;
    let peak = 0;
    const scheduler = new Scheduler<null>({
      agents: () => agentIds(4),
      maxConcurrency: 1,
      rng: createRng(3),
      tick: async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await sleep(1);
        concurrent -= 1;
        return ok(null);
      },
    });

    await scheduler.runRound();
    assert.equal(peak, 1);
  });
});

describe('an agent never ticks twice at the same time', () => {
  it('defers an agent whose previous tick is still in flight', async () => {
    const ids = agentIds(3);
    const active = new Map<AgentId, number>();
    let overlaps = 0;

    const scheduler = new Scheduler<null>({
      agents: () => ids,
      // Every agent in flight at once, so a second round finds them all busy.
      maxConcurrency: ids.length,
      rng: createRng(4),
      tick: async (agentId) => {
        const running = (active.get(agentId) ?? 0) + 1;
        active.set(agentId, running);
        if (running > 1) overlaps += 1;
        await sleep(40);
        active.set(agentId, running - 1);
        return ok(null);
      },
    });

    // Start a round and, without waiting for it, ask for another.
    const first = scheduler.runRound();
    assert.equal(scheduler.inFlightCount(), ids.length, 'the first round claimed every agent');
    const second = await scheduler.runRound();

    assert.equal(second.outcomes.length, 0, 'the second round ticks nobody');
    assert.deepEqual(
      [...second.deferred].sort(),
      [...ids].sort(),
      'and reports every agent as deferred rather than silently dropping it',
    );

    const firstReport = await first;
    assert.equal(firstReport.outcomes.length, ids.length);
    assert.equal(overlaps, 0, 'no agent was ever ticked concurrently with itself');
  });

  it('keeps per-agent exclusion while other agents proceed', async () => {
    const ids = agentIds(6);
    const active = new Set<AgentId>();
    let overlaps = 0;

    const scheduler = new Scheduler<null>({
      agents: () => ids,
      maxConcurrency: 2,
      rng: createRng(5),
      tick: async (agentId) => {
        if (active.has(agentId)) overlaps += 1;
        active.add(agentId);
        await sleep(5);
        active.delete(agentId);
        return ok(null);
      },
    });

    // Two rounds racing: agents still busy are deferred, the rest are ticked.
    const [a, b] = await Promise.all([scheduler.runRound(), scheduler.runRound()]);

    assert.equal(overlaps, 0);
    assert.ok(
      a.outcomes.length + b.outcomes.length >= ids.length,
      'between them the two rounds should cover the roster',
    );
    assert.equal(scheduler.inFlightCount(), 0, 'nothing is left in flight');
  });
});

describe('the tick rotation is fair and reproducible', () => {
  async function collect(scheduler: Scheduler<null>, rounds: number): Promise<AgentId[][]> {
    const out: AgentId[][] = [];
    for (let i = 0; i < rounds; i++) {
      const report = await scheduler.runRound();
      out.push([...report.order]);
    }
    return out;
  }

  it('gives different agents first pick across rounds', async () => {
    const scheduler = new Scheduler<null>({
      agents: () => agentIds(5),
      maxConcurrency: 2,
      rng: createRng(11),
      tick: async () => ok(null),
    });

    const rotations = await collect(scheduler, 12);
    const firstPicks = new Set(rotations.map((order) => order[0]));

    assert.ok(
      firstPicks.size > 1,
      'a single fixed ordering would hand the same agent contested work every round',
    );
    for (const order of rotations) {
      assert.equal(new Set(order).size, 5, 'every round is a permutation of the roster');
    }
  });

  it('produces the same rotation from the same seed', async () => {
    const build = (): Scheduler<null> =>
      new Scheduler<null>({
        agents: () => agentIds(5),
        maxConcurrency: 2,
        rng: createRng(99),
        tick: async () => ok(null),
      });

    const a = await collect(build(), 5);
    const b = await collect(build(), 5);
    assert.deepEqual(a, b, 'wall-clock order is lost to concurrency; the rotation is not');
  });
});

describe('a round survives what happens inside it', () => {
  it('records a thrown tick as a failure instead of taking the round down', async () => {
    const ids = agentIds(3);
    const scheduler = new Scheduler<string>({
      agents: () => ids,
      maxConcurrency: 3,
      rng: createRng(6),
      tick: async (agentId) => {
        if (agentId === ids[1]) throw new Error('the bridge exploded');
        return ok('fine');
      },
    });

    const report = await scheduler.runRound();

    assert.equal(report.outcomes.length, 3, 'the other two agents still had their turn');
    const thrown = report.outcomes.find((outcome) => outcome.agentId === ids[1])!;
    assert.equal(thrown.result.ok, false);
    if (!thrown.result.ok) {
      assert.equal(thrown.result.failure.kind, 'INTERNAL');
      assert.match(thrown.result.failure.detail, /the bridge exploded/);
    }
  });

  it('passes a failed tick through as a value', async () => {
    const scheduler = new Scheduler<string>({
      agents: () => agentIds(2),
      maxConcurrency: 2,
      rng: createRng(7),
      tick: async () => fail('ENVIRONMENT_DISCONNECTED', 'no bridge'),
    });

    const report = await scheduler.runRound();
    assert.equal(successes(report).length, 0);
    assert.equal(report.outcomes.every((outcome) => !outcome.result.ok), true);
  });

  it('stops mid-round when asked to', async () => {
    let ticked = 0;
    let stop = false;
    const scheduler = new Scheduler<null>({
      agents: () => agentIds(10),
      maxConcurrency: 1,
      rng: createRng(8),
      stopping: () => stop,
      tick: async () => {
        ticked += 1;
        if (ticked === 3) stop = true;
        return ok(null);
      },
    });

    const report = await scheduler.runRound();
    assert.equal(ticked, 3, 'the round abandons the rest of its queue');
    assert.equal(report.outcomes.length, 3);
  });

  it('ticks only the agents that are eligible now', async () => {
    let roster = agentIds(3);
    const ticked: AgentId[] = [];
    const scheduler = new Scheduler<null>({
      agents: () => roster,
      maxConcurrency: 3,
      rng: createRng(9),
      tick: async (agentId) => {
        ticked.push(agentId);
        return ok(null);
      },
    });

    await scheduler.runRound();
    // Someone died between rounds; the roster function is re-read.
    roster = roster.slice(0, 1);
    const second = await scheduler.runRound();

    assert.equal(second.outcomes.length, 1);
    assert.equal(ticked.length, 4);
  });

  it('runs rounds until told to stop', async () => {
    let rounds = 0;
    const scheduler = new Scheduler<null>({
      agents: () => agentIds(2),
      maxConcurrency: 2,
      rng: createRng(10),
      tick: async () => ok(null),
    });

    const reports = await scheduler.runRounds(() => {
      rounds += 1;
      return rounds < 4;
    });

    assert.equal(reports.length, 4);
    assert.equal(reports.every((report) => report.outcomes.length === 2), true);
  });
});
