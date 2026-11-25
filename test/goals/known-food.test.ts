import assert from 'node:assert/strict';
import { it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NEUTRAL_PERSONALITY, NO_SKILLS, STARTING_NEEDS, type Agent } from '../../src/agents/agent.ts';
import { tickAgent } from '../../src/agents/runtime.ts';
import { defaultConfig } from '../../src/core/config.ts';
import { fail, type ActionFailure } from '../../src/core/result.ts';
import { sequentialIdFactory, type AgentId } from '../../src/core/ids.ts';
import { position, regionPositions, type Position, type Region } from '../../src/core/world.ts';
import { flatEnvironment } from '../../src/environment/fake/environment.ts';
import { executeStep } from '../../src/goals/actions.ts';
import type { Goal } from '../../src/goals/goal.ts';
import { buildPlan, excludedFoodBeliefsFromFailedPlans, type PlanningContext } from '../../src/goals/planner.ts';
import { makeStep, type Plan, type PlanStep } from '../../src/goals/plan.ts';
import { OBSERVED, type KnownResource } from '../../src/memory/types.ts';
import { agentOwner } from '../../src/persistence/repositories/ledger.ts';
import { Store } from '../../src/persistence/store.ts';
import { HeuristicProvider } from '../../src/reasoning/heuristic.ts';

function fixture(store = Store.openMemory(sequentialIdFactory())) {
  const ids = store.ids;
  store.simulation.initialise('known-food-fixture', 1, 1_700_000_000_000);
  const agent: Agent = {
    id: 'agent_000001' as AgentId, name: 'Arun', role: 'Explorer',
    personality: NEUTRAL_PERSONALITY, skills: NO_SKILLS,
    needs: { ...STARTING_NEEDS, food: 0.2 }, position: position(0, 68, 0),
    health: 1, status: 'idle', phase: 'act', currentGoalId: null, lastTickAt: 0,
    activity: '', spawnedAtDay: 0,
  };
  store.agents.insert(agent);
  const known: KnownResource = {
    agentId: agent.id, resource: 'food', position: position(120, 68, 0),
    estimatedQuantity: 6, confidence: 0.9, source: OBSERVED,
    discoveredAtDay: 0, lastSeenAtTicks: 0,
  };
  const goal: Goal = {
    id: 'goal_food' as Goal['id'], agentId: agent.id, kind: 'find_food',
    params: { quantity: 6 }, state: 'active', priority: 0.9, reason: 'hungry',
    parentGoalId: null, createdAtDay: 0, createdAtTicks: 0,
    resolvedAtTicks: null, outcome: null,
  };
  const context: PlanningContext = {
    agent, time: store.simulation.currentTime(), knownResources: [known],
    knownShelter: null, settlementCenter: null, carrying: {}, memories: [],
    claimedWork: [], existingStructures: [], sharedStore: null, work: null,
    sheltered: false, hostilesNearby: 0,
  };
  return { ids, store, agent, known, goal, context };
}

function foodInFixtureRegion(environment: ReturnType<typeof flatEnvironment>): number {
  let count = 0;
  for (let x = 108; x <= 132; x++) for (let z = -12; z <= 12; z++) for (let y = 62; y <= 76; y++) {
    if (environment.world.blockAt(position(x, y, z)).yields === 'food') count++;
  }
  return count;
}

it('visits distant remembered food, verifies a real harvest and eats from the ledger', async () => {
  const { ids, store, known, goal, context } = fixture();
  const environment = flatEnvironment();
  await environment.connect();
  try {
    store.knowledge.rememberResource(known);
    for (let x = 120; x < 126; x++) {
      environment.world.setBlock(position(x, 68, 0), { surface: 'vegetation', yields: 'food', solid: true });
    }
    const foodBefore = foodInFixtureRegion(environment);
    const plan = buildPlan(goal, context, ids);
    assert.deepEqual(plan.steps.map(step => step.action), ['travel_to', 'harvest_resource', 'eat']);
    assert.deepEqual(plan.steps[0]?.params, { target: { kind: 'position', position: known.position } });
    let agent = context.agent;
    for (const step of plan.steps) {
      let done = false;
      for (let tick = 0; tick < 64; tick++) {
        const result = await executeStep(step, { store, environment, agent, goal, time: context.time });
        assert.ok(result.ok, result.ok ? '' : result.failure.detail);
        agent = { ...agent, ...result.value.agentPatch };
        store.agents.update(agent);
        if (!result.value.incomplete) { done = true; break; }
      }
      assert.ok(done, `${step.action} must complete within the bounded fixture`);
    }
    assert.ok(agent.position.x >= 118, 'the agent left the 80-block local search radius');
    assert.equal(store.ledger.quantity(agentOwner(agent.id), 'food'), 2);
    assert.equal(foodBefore - foodInFixtureRegion(environment), 6, 'ledger credit matches actual world removal');
    assert.ok(Math.abs(agent.needs.food - 0.8) < 1e-10);
    const collected = store.events.query({ types: ['resource_collected'] });
    assert.equal(collected.length, 1);
    assert.equal((collected[0]?.payload as { quantity: number }).quantity, 6);
    assert.equal(store.events.query({ types: ['resource_spent'] }).length, 1);
    assert.equal(store.events.query({ types: ['resource_discovered'] }).length, 0);
  } finally { await environment.disconnect(); store.close(); }
});

it('keeps carried-food priority even when a distant food source is remembered', () => {
  const { ids, store, goal, context } = fixture();
  try {
    for (const attempt of [0, 1, 2]) {
      assert.deepEqual(buildPlan(goal, { ...context, carrying: { food: 2 } }, ids, attempt).steps.map(s => s.action), ['eat']);
    }
  } finally { store.close(); }
});

it('retains local discovery for exhausted food beliefs and unrelated resources', () => {
  const { ids, store, known, goal, context } = fixture();
  try {
    for (const belief of [{ ...known, confidence: 0 }, { ...known, resource: 'wood' as const }]) {
      assert.equal(buildPlan(goal, { ...context, knownResources: [belief] }, ids).steps[0]?.action, 'locate_resource');
    }
  } finally { store.close(); }
});

it('reserves the third plan for fresh ground even with a known site', () => {
  const { ids, store, goal, context } = fixture();
  try {
    const plan = buildPlan(goal, context, ids, 2);
    assert.deepEqual(plan.steps.map(s => s.action), ['travel_to', 'survey_area', 'locate_resource', 'travel_to', 'harvest_resource', 'eat']);
    assert.equal((plan.steps[0]?.params as { target: { kind: string } }).target.kind, 'position');
  } finally { store.close(); }
});

it('does not credit imaginary food when the remembered ground is now empty', async () => {
  const { ids, store, known, goal, context } = fixture();
  const environment = flatEnvironment();
  await environment.connect();
  try {
    store.knowledge.rememberResource(known);
    const midpoint = position(known.position.x, known.position.y + 1, known.position.z);
    store.knowledge.rememberResource({ ...known, position: midpoint });
    for (let x = 108; x <= 132; x++) for (let z = -12; z <= 12; z++) for (let y = 62; y <= 76; y++) {
      const p = position(x, y, z);
      if (environment.world.blockAt(p).yields === 'food') {
        environment.world.setBlock(p, { surface: 'unknown', yields: null, solid: false });
      }
    }
    const plan = buildPlan(goal, context, ids);
    assert.equal(plan.steps[1]?.action, 'harvest_resource');
    const harvest = plan.steps[1] as PlanStep;
    const agent = { ...context.agent, position: known.position };
    const result = await executeStep(harvest, { store, environment, agent, goal, time: context.time });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.failure.kind, 'RESOURCE_UNAVAILABLE');
    assert.equal(store.ledger.quantity(agentOwner(agent.id), 'food'), 0);
    assert.equal(store.events.query({ types: ['resource_collected'] }).length, 0);
    assert.deepEqual(store.knowledge.knownResources(agent.id, 'food').map(row => row.position), [midpoint]);
    const corrected = store.knowledge.knownResources(agent.id, 'food', 0).find(row => row.position.y === known.position.y);
    assert.equal(corrected?.confidence, 0);
    assert.equal(corrected?.estimatedQuantity, 0);
  } finally { await environment.disconnect(); store.close(); }
});

it('breaks equal-distance ties by numeric floored coordinates and falls back when all sites are excluded', () => {
  const { ids, store, known, goal, context } = fixture();
  try {
    const a = { ...known, position: position(12.7, 68.3, 0.3) };
    const b = { ...known, position: position(-11.2, 68.3, 0.3) };
    for (const knownResources of [[a, b], [b, a]]) {
      const plan = buildPlan(goal, { ...context, knownResources }, ids, 1);
      assert.deepEqual(plan.steps[0]?.params, { target: { kind: 'position', position: position(-12, 68, 0) } });
    }

    const unavailable = new Set(['12,68,0', '-12,68,0']);
    const first = buildPlan(goal, { ...context, knownResources: [a, b] }, ids, 0, unavailable);
    assert.deepEqual(first.steps.map(step => step.action), ['locate_resource', 'travel_to', 'harvest_resource', 'eat']);
    const second = buildPlan(goal, { ...context, knownResources: [a, b] }, ids, 1, unavailable);
    assert.deepEqual(second.steps.map(step => step.action), ['travel_to', 'survey_area', 'locate_resource', 'travel_to', 'harvest_resource', 'eat']);
    assert.deepEqual(second.steps[3]?.params, { target: { kind: 'resource', resource: 'food' } });
  } finally { store.close(); }
});

it('retries active travel, then rotates after a terminal block and resumes the bound harvest after reopening', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'worldloom-food-rotation-'));
  const path = join(directory, 'worldloom.sqlite');
  let store = Store.open(path);
  const { ids, agent, known, goal, context } = fixture(store);
  const first = { ...known, position: position(30, 68, 0) };
  const second = known;
  const volume: Region = { min: position(108, 62, -12), max: position(132, 76, 12) };
  const environment = flatEnvironment();
  await environment.connect();
  try {
    store.knowledge.rememberResource(first);
    store.knowledge.rememberResource(second);
    store.goals.insert(goal);
    store.agents.update({ ...agent, currentGoalId: goal.id });
    const initial = buildPlan(goal, { ...context, knownResources: [first, second] }, ids);
    store.plans.insert(initial);

    const destinations: Position[] = [];
    const move = environment.moveAgent.bind(environment);
    environment.moveAgent = async (view, to) => {
      destinations.push(to);
      if (to.x === first.position.x) return fail('PATH_BLOCKED', 'fixture blocks first ground');
      return move(view, to);
    };
    for (const point of regionPositions(volume)) {
      if (environment.world.blockAt(point).yields === 'food') environment.world.removeBlock(point);
    }
    const food = [position(120, 68, 0), position(121, 68, 0)];
    for (const point of food) environment.world.setBlock(point, { surface: 'vegetation', yields: 'food', solid: true });
    const harvests: Region[] = [];
    const harvest = environment.harvest.bind(environment);
    environment.harvest = async (view, bounds, resource, amount) => {
      harvests.push(bounds);
      return harvest(view, bounds, resource, amount);
    };

    const reasoning = new HeuristicProvider();
    const config = defaultConfig();
    const tick = () => tickAgent(agent.id, { store, environment, reasoning, config });
    const retry = await tick();
    assert.ok(retry.ok);
    assert.equal(retry.value.plan?.id, initial.id);
    assert.equal(retry.value.plan?.state, 'active');
    assert.equal(store.plans.historyForGoal(goal.id).length, 1);

    const blocked = await tick();
    assert.ok(blocked.ok);
    assert.equal(blocked.value.failure?.kind, 'PATH_BLOCKED');
    const replacement = store.plans.activeForGoal(goal.id);
    assert.ok(replacement);
    assert.equal(replacement.revision, 1);
    assert.deepEqual(replacement.steps[0]?.params, { target: { kind: 'position', position: second.position } });
    assert.equal(store.knowledge.knownResources(agent.id, 'food').find(row => row.position.x === first.position.x)?.confidence, first.confidence);

    store.close();
    store = Store.open(path);
    assert.deepEqual(store.plans.activeForGoal(goal.id), replacement);

    const owner = agentOwner(agent.id);
    for (let tickCount = 0; tickCount < 64 && harvests.length === 0; tickCount++) {
      const result = await tick();
      assert.ok(result.ok);
      assert.equal(result.value.failure, null);
    }
    assert.deepEqual(destinations.slice(0, 2), [first.position, first.position]);
    assert.ok(destinations.length > 2);
    assert.ok(destinations.slice(2).every(target => target.x === second.position.x && target.y === second.position.y && target.z === second.position.z));
    assert.deepEqual(harvests, [volume]);
    assert.ok(food.every(point => environment.world.blockAt(point).yields !== 'food'));
    assert.equal(store.ledger.quantity(owner, 'food'), 2);
    const eaten = await tick();
    assert.ok(eaten.ok);
    assert.equal(eaten.value.action, 'eat');
    assert.equal(store.ledger.quantity(owner, 'food'), 0);
    assert.deepEqual(store.events.query({ types: ['resource_spent'] }).map(event => event.payload), [
      { agentId: agent.id, resources: { food: 2 }, reason: 'eating' },
    ]);
  } finally {
    await environment.disconnect();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('excludes only the ground attached to a qualifying terminal step of this goal', () => {
  const { ids, store, goal, context, known } = fixture();
  try {
    const plan = buildPlan(goal, context, ids);
    const terminal = (p: Plan, i: number, kind: ActionFailure['kind']): Plan => ({
      ...p, state: 'failed', currentStep: i,
      steps: p.steps.map((step, index) => index === i
        ? { ...step, status: 'failed', failure: { kind, detail: 'fixture' } }
        : step),
    });
    const blocked = terminal(plan, 0, 'PATH_BLOCKED');
    const depleted = terminal(plan, 1, 'RESOURCE_UNAVAILABLE');
    const pendingCurrent = {
      ...blocked,
      steps: blocked.steps.map((step, i) => i === 0 ? { ...step, status: 'pending' as const } : step),
    };
    const legacy = terminal({
      ...plan, steps: [
        makeStep(0, 'travel_to', { target: { kind: 'resource', resource: 'food' } }),
        makeStep(1, 'harvest_resource', { resource: 'food', quantity: 6 }),
      ],
    }, 0, 'PATH_BLOCKED');
    const mismatch = terminal({
      ...plan, steps: [
        makeStep(0, 'travel_to', { target: { kind: 'position', position: position(30, 68, 0) } }),
        plan.steps[1]!,
      ],
    }, 0, 'PATH_BLOCKED');
    const nonFood = terminal({
      ...plan, steps: [makeStep(0, 'harvest_resource', {
        resource: 'wood', quantity: 2, believedAt: known.position,
        from: { min: known.position, max: known.position },
      })],
    }, 0, 'RESOURCE_UNAVAILABLE');
    for (const other of [
      { ...blocked, state: 'active' as const },
      { ...blocked, state: 'superseded' as const },
      { ...blocked, state: 'completed' as const },
      { ...blocked, goalId: 'another-goal' as Goal['id'] },
      terminal(plan, 2, 'RESOURCE_UNAVAILABLE'),
      terminal(plan, 0, 'TIMEOUT'),
      legacy, mismatch, nonFood, pendingCurrent,
    ]) {
      assert.equal(excludedFoodBeliefsFromFailedPlans(goal.id, [other]).size, 0);
    }
    for (const failure of [blocked, depleted]) {
      assert.deepEqual([...excludedFoodBeliefsFromFailedPlans(goal.id, [failure])], ['120,68,0']);
    }
  } finally { store.close(); }
});

it('spends the final plan exploring and abandons after the third terminal failure', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'worldloom-food-cap-'));
  const path = join(directory, 'worldloom.sqlite');
  let store = Store.open(path);
  const { ids, agent, goal, context, known } = fixture(store);
  const grounds = [30, 65, 120].map(x => ({ ...known, position: position(x, 68, 0) }));
  const environment = flatEnvironment();
  await environment.connect();
  try {
    for (const ground of grounds) store.knowledge.rememberResource(ground);
    store.goals.insert(goal);
    store.agents.update({ ...agent, currentGoalId: goal.id });
    store.plans.insert(buildPlan(goal, { ...context, knownResources: grounds }, ids));
    environment.moveAgent = async () => fail('PATH_BLOCKED', 'all fixture routes blocked', { retryable: false });
    const reasoning = new HeuristicProvider();
    const config = defaultConfig();
    const tick = () => tickAgent(agent.id, { store, environment, reasoning, config });

    assert.ok((await tick()).ok);
    assert.deepEqual(store.plans.activeForGoal(goal.id)?.steps[0]?.params, {
      target: { kind: 'position', position: grounds[1]!.position },
    });
    store.close();
    store = Store.open(path);
    assert.deepEqual([...excludedFoodBeliefsFromFailedPlans(goal.id, store.plans.historyForGoal(goal.id))], ['30,68,0']);
    assert.ok((await tick()).ok);
    const final = store.plans.activeForGoal(goal.id);
    assert.ok(final);
    assert.equal(final.revision, 2);
    assert.deepEqual(
      [...excludedFoodBeliefsFromFailedPlans(goal.id, store.plans.historyForGoal(goal.id))],
      ['30,68,0', '65,68,0'],
    );
    assert.deepEqual(final.steps.map(step => step.action),
      ['travel_to', 'survey_area', 'locate_resource', 'travel_to', 'harvest_resource', 'eat']);
    assert.equal(store.knowledge.knownResources(agent.id, 'food').length, 3);

    assert.ok((await tick()).ok);
    assert.equal(store.goals.find(goal.id)?.state, 'abandoned');
    assert.equal(store.plans.activeForGoal(goal.id), null);
    assert.equal(store.plans.historyForGoal(goal.id).length, 3);
  } finally {
    await environment.disconnect();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
