/**
 * M3's milestone criteria, end to end.
 *
 * Five agents run concurrently; one discovers a resource, tells another, and the
 * recipient's `known_resources` gains a row sourced `told_by:<id>`; a helpful act
 * moves a relationship value and the event explains why.
 *
 * Nothing here is staged. The discovery comes out of the real `locate_resource`
 * executor reading the real fake world, the message goes through the real
 * messaging path, and the relationship moves because of a real ledger row — so
 * the criteria are demonstrated rather than asserted about fixtures.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Agent } from '../src/agents/agent.ts';
import { drainInbox, tell } from '../src/agents/messaging.ts';
import { tickAgent } from '../src/agents/runtime.ts';
import { parseConfig, type WorldloomConfig } from '../src/core/config.ts';
import { sequentialIdFactory } from '../src/core/ids.ts';
import { createRng } from '../src/core/rng.ts';
import { expect } from '../src/core/result.ts';
import { position, type WorldTime } from '../src/core/world.ts';
import { FakeEnvironment } from '../src/environment/fake/environment.ts';
import { executeStep } from '../src/goals/actions.ts';
import type { Goal } from '../src/goals/goal.ts';
import { formatSource } from '../src/memory/types.ts';
import { Store } from '../src/persistence/store.ts';
import { HeuristicProvider } from '../src/reasoning/heuristic.ts';
import { Scheduler } from '../src/scheduler/runtime.ts';
import { silentLogger } from '../src/observability/logger.ts';
import { Simulation } from '../src/simulation.ts';
import { foundSettlement } from '../src/scenarios/first-settlement.ts';

function testConfig(overrides: Record<string, unknown> = {}): WorldloomConfig {
  return expect(
    parseConfig(
      {
        simulation: { agents: 5, tick_interval_seconds: 0, max_days: 1, seed: 42 },
        environment: { type: 'fake' },
        reasoning: { provider: 'heuristic' },
        ...overrides,
      },
      {},
    ),
    'config',
  );
}

interface World {
  readonly store: Store;
  readonly environment: FakeEnvironment;
  readonly agents: readonly Agent[];
  readonly time: WorldTime;
}

/** Two settlers standing on real ground in a real world, and nothing more. */
async function settled(agentCount = 2, seed = 3): Promise<World> {
  const store = Store.openMemory(sequentialIdFactory());
  store.simulation.initialise('five-agents-test', seed);

  const environment = new FakeEnvironment({ seed, startTicks: 1_000, ticksPerQuery: 0 });
  expect(await environment.connect(), 'connect');

  const info = environment.describe();
  const survey = await environment.surveyRegion(
    {
      min: { x: -12, y: info.elevationRange.min, z: -12 },
      max: { x: 12, y: info.elevationRange.max, z: 12 },
    },
    1,
  );
  const ground = new Map<string, number>();
  if (survey.ok) for (const cell of survey.value.cells) ground.set(`${cell.x},${cell.z}`, cell.y);

  const setup = foundSettlement({
    store,
    ids: store.ids,
    rng: createRng(7),
    center: position(0, 64, 0),
    agentCount,
    surfaceAt: (x, z) => ground.get(`${Math.round(x)},${Math.round(z)}`) ?? null,
  });

  return { store, environment, agents: setup.agents, time: store.simulation.currentTime() };
}

/** A goal to hang a directly executed step off. */
function gatherGoal(agent: Agent): Goal {
  return {
    id: 'goal_probe' as never,
    agentId: agent.id,
    kind: 'gather_resource',
    params: { resource: 'coal', quantity: 8 },
    state: 'active',
    priority: 0.5,
    reason: 'to see what is here',
    parentGoalId: null,
    createdAtDay: 0,
    createdAtTicks: 0,
    resolvedAtTicks: null,
    outcome: null,
  };
}

/** Have an agent actually look around, and return what it found. */
async function discoverCoal(world: World, finder: Agent): Promise<{ position: ReturnType<typeof position>; estimatedQuantity: number }> {
  const outcome = await executeStep(
    {
      index: 0,
      action: 'locate_resource',
      params: { resource: 'coal', searchRadius: 80 },
      status: 'active',
      attempts: 1,
      failure: null,
      note: null,
    },
    {
      store: world.store,
      environment: world.environment,
      agent: world.store.agents.get(finder.id),
      goal: gatherGoal(finder),
      time: world.time,
    },
  );
  expect(outcome, 'the finder should see coal in this world');

  const found = world.store.knowledge.knownResources(finder.id, 'coal');
  assert.ok(found.length > 0, 'the finder now believes in a deposit it saw for itself');
  return { position: found[0]!.position, estimatedQuantity: found[0]!.estimatedQuantity };
}

describe('knowledge crosses from one agent to another only by being told', () => {
  it('gives the recipient a coal deposit sourced told_by the agent who found it', async () => {
    const world = await settled();
    const [finder, listener] = world.agents;

    // ── One agent discovers something ────────────────────────────────────────
    const deposit = await discoverCoal(world, finder!);
    const finderBelief = world.store.knowledge.knownResources(finder!.id, 'coal')[0]!;
    assert.equal(formatSource(finderBelief.source), 'observed');

    // ── And the other genuinely does not know about it ───────────────────────
    const before = world.store.knowledge.knownResources(listener!.id, 'coal');
    assert.equal(before.length, 0, 'nothing has crossed yet — there is no shared world model');

    // ── One tells the other ─────────────────────────────────────────────────
    expect(
      tell(
        { store: world.store, time: world.time },
        {
          fromAgentId: finder!.id,
          toAgentId: listener!.id,
          intent: {
            kind: 'discovery',
            subject: 'coal',
            resource: 'coal',
            at: deposit.position,
            estimatedQuantity: deposit.estimatedQuantity,
          },
        },
      ),
      'tell',
    );

    const drained = expect(
      await drainInbox(listener!.id, {
        store: world.store,
        reasoning: new HeuristicProvider(),
        time: world.time,
      }),
      'drain',
    );

    // ── The recipient gains a row it did not have, sourced told_by ───────────
    const after = world.store.knowledge.knownResources(listener!.id, 'coal');
    assert.equal(after.length, 1, 'exactly the one deposit it was told about');
    assert.equal(formatSource(after[0]!.source), `told_by:${finder!.id}`);
    assert.ok(
      after[0]!.confidence < finderBelief.confidence,
      'and it holds the rumour less firmly than the finder holds what it saw',
    );
    assert.equal(drained.outcomes[0]!.wasNews, true);

    // ── The crossing is in the ledger ───────────────────────────────────────
    const shared = world.store.events.query({ types: ['knowledge_shared'] });
    assert.equal(shared.length, 1);
    const payload = shared[0]!.payload as { fromAgentId: string; toAgentId: string };
    assert.equal(payload.fromAgentId, finder!.id);
    assert.equal(payload.toAgentId, listener!.id);

    await world.environment.disconnect();
  });
});

describe('a relationship moves because of something that happened', () => {
  it('records the event that explains why the recipient now trusts the teller', async () => {
    const world = await settled();
    const [finder, listener] = world.agents;

    assert.equal(
      world.store.knowledge.relationship(listener!.id, finder!.id),
      null,
      'they start as strangers',
    );

    const deposit = await discoverCoal(world, finder!);
    expect(
      tell(
        { store: world.store, time: world.time },
        {
          fromAgentId: finder!.id,
          toAgentId: listener!.id,
          intent: {
            kind: 'discovery',
            subject: 'coal',
            resource: 'coal',
            at: deposit.position,
            estimatedQuantity: deposit.estimatedQuantity,
          },
        },
      ),
      'tell',
    );
    expect(
      await drainInbox(listener!.id, {
        store: world.store,
        reasoning: new HeuristicProvider(),
        time: world.time,
      }),
      'drain',
    );

    const view = world.store.knowledge.relationship(listener!.id, finder!.id)!;

    // The value moved.
    assert.ok(view.trust > 0, 'a useful thing to be told is evidence their word is worth having');
    assert.ok(view.familiarity > 0);
    assert.ok(view.interactions > 0);

    // And the stored row points at the event that explains it — requirement 47.
    assert.notEqual(view.lastEventId, null);
    const because = world.store.events.find(view.lastEventId!);
    assert.notEqual(because, null, 'last_event_id must resolve to a real ledger row');
    assert.equal(because!.type, 'knowledge_shared');
    assert.equal((because!.payload as { toAgentId: string }).toAgentId, listener!.id);
    assert.match(view.lastReason ?? '', /told me about coal/);

    // The change is itself in the history, so the chronicle can narrate it.
    const changed = world.store.events.query({ types: ['relationship_changed'] });
    assert.ok(changed.length > 0);
    assert.equal((changed[0]!.payload as { agentId: string }).agentId, listener!.id);

    await world.environment.disconnect();
  });

  it('leaves the teller\'s view of the listener unchanged in trust', async () => {
    const world = await settled();
    const [finder, listener] = world.agents;
    const deposit = await discoverCoal(world, finder!);

    expect(
      tell(
        { store: world.store, time: world.time },
        {
          fromAgentId: finder!.id,
          toAgentId: listener!.id,
          intent: {
            kind: 'discovery',
            subject: 'coal',
            resource: 'coal',
            at: deposit.position,
            estimatedQuantity: deposit.estimatedQuantity,
          },
        },
      ),
      'tell',
    );
    expect(
      await drainInbox(listener!.id, {
        store: world.store,
        reasoning: new HeuristicProvider(),
        time: world.time,
      }),
      'drain',
    );

    const theirView = world.store.knowledge.relationship(finder!.id, listener!.id);
    assert.equal(theirView?.trust, 0, 'giving away news teaches you nothing about the listener');
    assert.ok((theirView?.familiarity ?? 0) > 0, 'though you do know them better for it');

    await world.environment.disconnect();
  });
});

describe('five agents run concurrently', () => {
  it('ticks all five through the scheduler without any of them interfering', async () => {
    const store = Store.openMemory(sequentialIdFactory());
    const config = testConfig();
    const simulation = Simulation.create({
      config,
      store,
      environment: new FakeEnvironment({ seed: 13, startTicks: 1_000, ticksPerQuery: 40 }),
      reasoning: new HeuristicProvider(),
      logger: silentLogger(),
      ids: store.ids,
    });

    const started = expect(await simulation.start(), 'start');
    assert.equal(started.agents.length, 5);

    const ticked = new Map<string, number>();
    const scheduler = new Scheduler({
      agents: () => store.agents.living().map((agent) => agent.id),
      maxConcurrency: config.reasoning.max_concurrency,
      rng: simulation.rng,
      tick: async (agentId) => {
        ticked.set(agentId, (ticked.get(agentId) ?? 0) + 1);
        return tickAgent(agentId, {
          store,
          environment: simulation.environment,
          reasoning: simulation.reasoning,
          config,
        });
      },
    });

    for (let round = 0; round < 10; round++) {
      const report = await scheduler.runRound();
      assert.equal(report.deferred.length, 0, 'a round should finish before the next one starts');
      assert.ok(
        report.peakConcurrency <= config.reasoning.max_concurrency,
        'the concurrency cap is a cap',
      );
      for (const outcome of report.outcomes) {
        assert.equal(outcome.result.ok, true, 'a tick should not fail outright');
      }
    }

    // Everyone got their turns, and each round was a full rotation.
    assert.equal(ticked.size, 5);
    for (const agent of started.agents) {
      assert.equal(ticked.get(agent.id), 10, `${agent.name} should have ticked once per round`);
    }

    // Each agent's beliefs are still its own: nothing leaked between them.
    for (const agent of started.agents) {
      for (const known of store.knowledge.knownResources(agent.id)) {
        assert.equal(known.agentId, agent.id);
      }
      for (const goal of store.goals.allFor(agent.id)) {
        assert.equal(goal.agentId, agent.id);
      }
    }

    // And the phase column is left in a coherent state rather than half-written
    // by two overlapping ticks.
    for (const agent of store.agents.all()) {
      assert.ok(
        ['observe', 'integrate', 'assess', 'plan', 'act', 'record'].includes(agent.phase),
        `${agent.name} ended in phase '${agent.phase}'`,
      );
    }

    await simulation.close();
  });

  it('spreads news through the settlement without anyone reading a mind', async () => {
    const world = await settled(5, 4);
    const [finder, ...others] = world.agents;
    const deposit = await discoverCoal(world, finder!);
    const reasoning = new HeuristicProvider();

    for (const other of others) {
      expect(
        tell(
          { store: world.store, time: world.time },
          {
            fromAgentId: finder!.id,
            toAgentId: other.id,
            intent: {
              kind: 'discovery',
              subject: 'coal',
              resource: 'coal',
              at: deposit.position,
              estimatedQuantity: deposit.estimatedQuantity,
            },
          },
        ),
        `tell ${other.name}`,
      );
    }

    // The four recipients drain their inboxes concurrently, as they would inside
    // a scheduler round.
    await Promise.all(
      others.map((other) =>
        drainInbox(other.id, { store: world.store, reasoning, time: world.time }),
      ),
    );

    for (const other of others) {
      const known = world.store.knowledge.knownResources(other.id, 'coal');
      assert.equal(known.length, 1, `${other.name} should have been told exactly once`);
      assert.equal(formatSource(known[0]!.source), `told_by:${finder!.id}`);
      assert.ok(world.store.knowledge.relationship(other.id, finder!.id)!.trust > 0);
    }

    // The finder learned nothing from telling people, and nobody learned from
    // anybody they did not speak to.
    assert.equal(world.store.knowledge.knownResources(finder!.id, 'coal').length >= 1, true);
    for (const other of others) {
      for (const yetAnother of others) {
        if (other.id === yetAnother.id) continue;
        assert.equal(
          world.store.knowledge.relationship(other.id, yetAnother.id),
          null,
          'two settlers who never spoke have no relationship at all',
        );
      }
    }

    await world.environment.disconnect();
  });
});
