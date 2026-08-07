/**
 * The M1 vertical slice, end to end.
 *
 * This is the test that decides whether Worldloom works at all: an agent
 * observes a world, forms a goal, plans it, performs a real verified change to
 * the world, remembers it, and — after the process is thrown away — continues
 * where it left off.
 *
 * It runs against `FakeEnvironment` and the rule-based provider, so it needs no
 * Minecraft server and no API key, and it exercises the same code a live run
 * does.
 */

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { tickAgent } from '../src/agents/runtime.ts';
import { defaultConfig, parseConfig, type WorldloomConfig } from '../src/core/config.ts';
import { sequentialIdFactory } from '../src/core/ids.ts';
import { expect } from '../src/core/result.ts';
import { position } from '../src/core/world.ts';
import { FakeEnvironment } from '../src/environment/fake/environment.ts';
import { HeuristicProvider } from '../src/reasoning/heuristic.ts';
import { agentOwner } from '../src/persistence/repositories/ledger.ts';
import { Store } from '../src/persistence/store.ts';
import { silentLogger } from '../src/observability/logger.ts';
import { Simulation } from '../src/simulation.ts';

function testConfig(overrides: Record<string, unknown> = {}): WorldloomConfig {
  return expect(
    parseConfig({
      simulation: { agents: 1, tick_interval_seconds: 0, max_days: 1, seed: 42 },
      environment: { type: 'fake' },
      reasoning: { provider: 'heuristic' },
      ...overrides,
    }, {}),
    'config',
  );
}

/** A world whose clock advances, so needs decay and days pass. */
function testEnvironment(seed = 3): FakeEnvironment {
  return new FakeEnvironment({ seed, startTicks: 1_000, ticksPerQuery: 220 });
}

describe('one agent, end to end', () => {
  it('observes, decides, plans, acts, and remembers', async () => {
    const store = Store.openMemory(sequentialIdFactory());
    const environment = testEnvironment();
    const simulation = Simulation.create({
      config: testConfig(),
      store,
      environment,
      reasoning: new HeuristicProvider(),
      logger: silentLogger(),
      ids: store.ids,
    });

    const started = expect(await simulation.start(), 'start');
    assert.equal(started.resumed, false);
    assert.equal(started.agents.length, 1);
    const agent = started.agents[0]!;

    // Arrival is recorded, and the agent knows only what it was told on arrival.
    assert.equal(store.events.query({ types: ['settlement_founded'] }).length, 1);
    assert.equal(store.events.query({ types: ['agent_spawned'] }).length, 1);
    assert.equal(store.knowledge.knownResources(agent.id).length, 0, 'knows of no deposits yet');

    // Run enough ticks for a goal to be chosen and worked on.
    for (let i = 0; i < 25; i++) {
      const report = expect(await tickAgent(agent.id, tickDeps(simulation)), `tick ${i}`);
      assert.equal(report.observed || report.note === 'nothing to do', true);
    }

    // A goal was formed, and it has a stated reason.
    const goals = store.goals.allFor(agent.id);
    assert.ok(goals.length > 0, 'the agent should have set itself a goal');
    assert.ok(goals.every((goal) => goal.reason.length > 0), 'every goal must say why');

    // A structured plan exists for it.
    const plans = store.plans.historyForGoal(goals[goals.length - 1]!.id);
    assert.ok(plans.length > 0, 'the goal should have a plan');
    assert.ok(plans[0]!.steps.length > 0, 'the plan should have steps');

    // Experience was stored as memory — the link a later decision can use.
    assert.ok(store.memories.count(agent.id) > 1, 'the agent should remember what it did');

    // The ledger only ever moved through verified world change.
    const collected = store.events.query({ types: ['resource_collected'] });
    for (const event of collected) {
      const payload = event.payload as { quantity: number; verifiedSample: number };
      assert.ok(payload.quantity > 0);
      assert.ok(payload.verifiedSample > 0, 'a credit must cite the verification behind it');
    }

    await simulation.close();
  });

  it('gathers only what the world actually held, then builds with it', async () => {
    const store = Store.openMemory(sequentialIdFactory());
    const environment = testEnvironment(11);
    const simulation = Simulation.create({
      config: testConfig(),
      store,
      environment,
      reasoning: new HeuristicProvider(),
      logger: silentLogger(),
      ids: store.ids,
    });

    const started = expect(await simulation.start(), 'start');
    const agent = started.agents[0]!;

    for (let i = 0; i < 120; i++) {
      await tickAgent(agent.id, tickDeps(simulation));
    }

    const collected = store.events.query({ types: ['resource_collected'] });
    const spent = store.events.query({ types: ['resource_spent'] });
    const balance = store.ledger.balance(agentOwner(agent.id));

    // Conservation: what the agent holds equals what it gathered (plus its
    // starting food) minus what it spent. Nothing appears from nowhere.
    const gained = collected.reduce(
      (total, event) => total + (event.payload as { quantity: number }).quantity,
      0,
    );
    const consumed = spent.reduce((total, event) => {
      const resources = (event.payload as { resources: Record<string, number> }).resources;
      return total + Object.values(resources).reduce((sum, n) => sum + n, 0);
    }, 0);
    const held = Object.values(balance).reduce((sum, n) => sum + (n ?? 0), 0);

    // Starting supplies are 4 food.
    assert.equal(held, gained + 4 - consumed, 'the resource economy must balance');

    await simulation.close();
  });

  it('finds a forest, walks to it, and gathers verified timber', async () => {
    // This is the whole causal chain in one behaviour: a goal the agent set
    // itself, a plan, a journey across real terrain, a harvest verified against
    // the world, and a ledger credited from that verification.
    const store = Store.openMemory(sequentialIdFactory());
    const simulation = Simulation.create({
      config: testConfig({ simulation: { agents: 1, tick_interval_seconds: 0, seed: 42 } }),
      store,
      environment: new FakeEnvironment({ seed: 3, startTicks: 1_000, ticksPerQuery: 40 }),
      reasoning: new HeuristicProvider(),
      logger: silentLogger(),
      ids: store.ids,
    });

    const started = expect(await simulation.start(), 'start');
    const agent = started.agents[0]!;

    for (let i = 0; i < 260; i++) await tickAgent(agent.id, tickDeps(simulation));

    const wood = store.ledger.quantity(agentOwner(agent.id), 'wood');
    assert.ok(wood > 0, 'the agent should have gathered timber from a real forest');

    // Every credit is backed by an event that cites its verification.
    const harvests = store.events
      .query({ types: ['resource_collected'] })
      .filter((event) => (event.payload as { resource: string }).resource === 'wood');
    assert.ok(harvests.length > 0, 'gathering wood should be in the ledger');
    for (const harvest of harvests) {
      const payload = harvest.payload as { quantity: number; verifiedSample: number };
      assert.ok(payload.verifiedSample > 0);
    }

    // And a gather goal actually completed, rather than being abandoned.
    const completed = store.events
      .query({ types: ['goal_completed'] })
      .filter((event) => (event.payload as { kind: string }).kind === 'gather_resource');
    assert.ok(completed.length > 0, 'a gathering goal should reach completion');

    await simulation.close();
  });

  it('records why every decision was made', async () => {
    const store = Store.openMemory(sequentialIdFactory());
    const simulation = Simulation.create({
      config: testConfig(),
      store,
      environment: testEnvironment(5),
      reasoning: new HeuristicProvider(),
      logger: silentLogger(),
      ids: store.ids,
    });

    const started = expect(await simulation.start(), 'start');
    const agent = started.agents[0]!;
    for (let i = 0; i < 20; i++) await tickAgent(agent.id, tickDeps(simulation));

    const decisions = store.decisions.forAgent(agent.id);
    assert.ok(decisions.length > 0, 'goal selection should leave an audit trail');
    for (const decision of decisions) {
      assert.equal(decision.category, 'goal_selection');
      assert.ok(decision.chosenAction.length > 0);
      // The observation the agent acted on must be recoverable.
      assert.ok(decision.observation !== null && typeof decision.observation === 'object');
    }

    await simulation.close();
  });

  it('spends nothing when running rule-based', async () => {
    const store = Store.openMemory(sequentialIdFactory());
    const simulation = Simulation.create({
      config: testConfig(),
      store,
      environment: testEnvironment(),
      reasoning: new HeuristicProvider(),
      logger: silentLogger(),
      ids: store.ids,
    });
    const started = expect(await simulation.start(), 'start');
    for (let i = 0; i < 10; i++) await tickAgent(started.agents[0]!.id, tickDeps(simulation));

    assert.equal(simulation.spentUsd(), 0);
    assert.equal(store.llmCalls.total().calls, 0);
    await simulation.close();
  });
});

describe('failure is surfaced and recovered from', () => {
  it('replans rather than repeating an impossible step', async () => {
    const store = Store.openMemory(sequentialIdFactory());
    // A flat world with no trees and no forage: gathering wood must fail.
    const environment = new FakeEnvironment({ seed: 1, amplitude: 0, ticksPerQuery: 200 });
    const simulation = Simulation.create({
      config: testConfig(),
      store,
      environment,
      reasoning: new HeuristicProvider(),
      logger: silentLogger(),
      ids: store.ids,
    });

    const started = expect(await simulation.start(), 'start');
    const agent = started.agents[0]!;

    for (let i = 0; i < 60; i++) await tickAgent(agent.id, tickDeps(simulation));

    const failures = store.events.query({ types: ['action_failed'] });
    assert.ok(failures.length > 0, 'a treeless world should produce real failures');

    // Failure reached the planner: either the plan was revised or the goal was
    // given up. Silently retrying forever is the behaviour this rules out.
    const revised = store.events.query({ types: ['plan_revised'] });
    const abandoned = store.events.query({ types: ['goal_abandoned'] });
    assert.ok(
      revised.length + abandoned.length > 0,
      'failure must reach the planner, not loop in the executor',
    );

    // No single step was attempted an unbounded number of times.
    for (const goal of store.goals.allFor(agent.id)) {
      for (const plan of store.plans.historyForGoal(goal.id)) {
        for (const step of plan.steps) {
          assert.ok(step.attempts <= 4, `step ${step.action} was attempted ${step.attempts} times`);
        }
      }
    }

    await simulation.close();
  });

  it('lowers its confidence in a deposit that turned out to be empty', async () => {
    const store = Store.openMemory(sequentialIdFactory());
    const environment = new FakeEnvironment({ seed: 2, amplitude: 0, ticksPerQuery: 100 });
    const simulation = Simulation.create({
      config: testConfig(),
      store,
      environment,
      reasoning: new HeuristicProvider(),
      logger: silentLogger(),
      ids: store.ids,
    });

    const started = expect(await simulation.start(), 'start');
    const agent = started.agents[0]!;

    // Plant a belief that is false: there is no iron in a flat shallow world.
    store.knowledge.rememberResource({
      agentId: agent.id,
      resource: 'iron',
      position: position(agent.position.x + 4, agent.position.y - 2, agent.position.z + 4),
      estimatedQuantity: 30,
      confidence: 0.9,
      source: { kind: 'observed' },
      discoveredAtDay: 0,
      lastSeenAtTicks: 0,
    });

    const believed = store.knowledge.knownResources(agent.id, 'iron');
    assert.equal(believed.length, 1);

    // Have the agent act on that belief directly.
    const { executeStep } = await import('../src/goals/actions.ts');
    const goal = {
      id: 'goal_test' as never,
      agentId: agent.id,
      kind: 'gather_resource' as const,
      params: { resource: 'iron' as const, quantity: 10 },
      state: 'active' as const,
      priority: 0.5,
      reason: 'test',
      parentGoalId: null,
      createdAtDay: 0,
      createdAtTicks: 0,
      resolvedAtTicks: null,
      outcome: null,
    };

    const result = await executeStep(
      {
        index: 0,
        action: 'harvest_resource',
        params: { resource: 'iron', quantity: 10 },
        status: 'active',
        attempts: 1,
        failure: null,
        note: null,
      },
      {
        store,
        environment,
        agent: store.agents.get(agent.id),
        goal,
        time: store.simulation.currentTime(),
      },
    );

    assert.equal(result.ok, false, 'there is no iron there to find');

    // The agent has learned. This is what stops replanning sending it back.
    assert.equal(
      store.knowledge.knownResources(agent.id, 'iron').length,
      0,
      'a failed harvest should end the belief that sent the agent there',
    );

    await simulation.close();
  });
});

describe('restart persistence', () => {
  it('continues the civilization after the process is thrown away', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'worldloom-slice-'));
    const path = join(dir, 'world.db');
    const config = testConfig({ persistence: { database: path } });

    // ── First process ───────────────────────────────────────────────────────
    const firstEnvironment = testEnvironment(7);
    const first = Simulation.create({
      config,
      environment: firstEnvironment,
      reasoning: new HeuristicProvider(),
      logger: silentLogger(),
    });

    const started = expect(await first.start(), 'start');
    assert.equal(started.resumed, false);
    const agentId = started.agents[0]!.id;
    const agentName = started.agents[0]!.name;

    for (let i = 0; i < 30; i++) await tickAgent(agentId, tickDeps(first));

    const beforeAgent = first.store.agents.get(agentId);
    const beforeGoals = first.store.goals.allFor(agentId).length;
    const beforeMemories = first.store.memories.count(agentId);
    const beforeEvents = first.store.events.count();
    const beforeBalance = first.store.ledger.balance(agentOwner(agentId));
    const beforeDay = first.store.simulation.currentTime().day;
    const beforeGoal = beforeAgent.currentGoalId;
    const beforePlan = beforeGoal === null ? null : first.store.plans.activeForGoal(beforeGoal);

    await first.close();

    // ── Second process: nothing in memory, only the file ────────────────────
    const second = Simulation.create({
      config,
      // A fresh environment object — the world itself is Minecraft's problem;
      // Worldloom's job is to remember the minds.
      environment: testEnvironment(7),
      reasoning: new HeuristicProvider(),
      logger: silentLogger(),
    });

    const resumed = expect(await second.start(), 'resume');
    assert.equal(resumed.resumed, true, 'the second process must recognise an existing world');
    assert.equal(resumed.agents.length, 1);

    const afterAgent = second.store.agents.get(agentId);
    assert.equal(afterAgent.name, agentName);
    assert.equal(afterAgent.phase, beforeAgent.phase, 'the tick phase resumes');
    assert.equal(afterAgent.currentGoalId, beforeGoal, 'the agent is still on the same goal');
    assert.deepEqual(afterAgent.needs, beforeAgent.needs, 'needs are not reset');
    assert.deepEqual(afterAgent.position, beforeAgent.position);

    assert.equal(second.store.goals.allFor(agentId).length, beforeGoals);
    assert.equal(second.store.memories.count(agentId), beforeMemories);
    assert.deepEqual(second.store.ledger.balance(agentOwner(agentId)), beforeBalance);
    assert.ok(second.store.events.count() > beforeEvents, 'resuming is itself an event');
    assert.ok(second.store.simulation.currentTime().day >= beforeDay, 'the clock did not rewind');

    if (beforePlan !== null) {
      const afterPlan = second.store.plans.activeForGoal(beforePlan.goalId);
      assert.equal(afterPlan?.id, beforePlan.id, 'the same plan is still live');
      assert.equal(afterPlan?.currentStep, beforePlan.currentStep, 'mid-plan, at the same step');
    }

    // And it keeps going from there rather than starting over. Progress is
    // measured by the ledger and the clock, not by new memories: an agent part
    // way through a journey correctly forms no new episodic memory per step.
    const eventsAtResume = second.store.events.count();
    const tickAtResume = second.store.agents.get(agentId).lastTickAt;

    for (let i = 0; i < 10; i++) await tickAgent(agentId, tickDeps(second));

    assert.ok(
      second.store.events.count() > eventsAtResume,
      'the resumed agent should carry on doing things',
    );
    assert.ok(
      second.store.agents.get(agentId).lastTickAt > tickAtResume,
      'and world time should keep advancing for it',
    );

    // The resumption is in the ledger, so the gap is part of the history.
    assert.equal(second.store.events.query({ types: ['simulation_resumed'] }).length, 1);

    await second.close();
  });

  it('does not re-found a settlement that already exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'worldloom-refound-'));
    const path = join(dir, 'world.db');
    const config = testConfig({ persistence: { database: path } });

    for (let run = 0; run < 3; run++) {
      const simulation = Simulation.create({
        config,
        environment: testEnvironment(4),
        reasoning: new HeuristicProvider(),
        logger: silentLogger(),
      });
      expect(await simulation.start(), `start ${run}`);
      await simulation.close();
    }

    const store = Store.open(path);
    assert.equal(
      store.events.query({ types: ['settlement_founded'] }).length,
      1,
      'a settlement is founded once, however many times the process runs',
    );
    assert.equal(store.agents.count(), 1, 'and its settlers are not duplicated');
    store.close();
  });
});

describe('five agents behave differently', () => {
  it('does not have every settler do the same thing', async () => {
    const store = Store.openMemory(sequentialIdFactory());
    const simulation = Simulation.create({
      config: testConfig({ simulation: { agents: 5, tick_interval_seconds: 0, seed: 9 } }),
      store,
      environment: testEnvironment(13),
      reasoning: new HeuristicProvider(),
      logger: silentLogger(),
      ids: store.ids,
    });

    const started = expect(await simulation.start(), 'start');
    assert.equal(started.agents.length, 5);

    // Distinct personalities and skills, not five copies.
    const roles = new Set(started.agents.map((agent) => agent.role));
    assert.equal(roles.size, 5, 'each settler should have a distinct role');
    const curiosities = new Set(started.agents.map((agent) => agent.personality.curiosity));
    assert.ok(curiosities.size > 1, 'personalities should actually differ');

    for (let round = 0; round < 12; round++) {
      await simulation.tickAll();
    }

    // Each agent keeps its own beliefs — Arun's discoveries are not Mira's.
    const knowledgeCounts = started.agents.map(
      (agent) => store.knowledge.knownResources(agent.id).length,
    );
    assert.ok(
      new Set(knowledgeCounts).size > 1 || knowledgeCounts.every((count) => count === 0),
      'agents should not magically share what they have each seen',
    );

    // Every goal belongs to exactly the agent that set it.
    for (const goal of store.goals.allActive()) {
      assert.ok(started.agents.some((agent) => agent.id === goal.agentId));
    }

    await simulation.close();
  });
});

describe('configuration', () => {
  it('runs against the fake environment with no key and no server', async () => {
    const config = defaultConfig();
    assert.equal(config.environment.type, 'minecraft', 'the default targets a real world');

    // ...but a test config can point it at the in-memory one, which is what
    // makes this whole suite possible.
    const testing = testConfig();
    assert.equal(testing.environment.type, 'fake');
    assert.equal(testing.reasoning.provider, 'heuristic');
  });
});

/** Assemble tick dependencies from a simulation. */
function tickDeps(simulation: Simulation): Parameters<typeof tickAgent>[1] {
  return {
    store: simulation.store,
    environment: simulation.environment,
    reasoning: simulation.reasoning,
    config: simulation.config,
  };
}
