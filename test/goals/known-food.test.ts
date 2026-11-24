import assert from 'node:assert/strict';
import { it } from 'node:test';
import { NEUTRAL_PERSONALITY, NO_SKILLS, STARTING_NEEDS, type Agent } from '../../src/agents/agent.ts';
import { sequentialIdFactory, type AgentId } from '../../src/core/ids.ts';
import { position } from '../../src/core/world.ts';
import { flatEnvironment } from '../../src/environment/fake/environment.ts';
import { executeStep } from '../../src/goals/actions.ts';
import type { Goal } from '../../src/goals/goal.ts';
import { buildPlan, type PlanningContext } from '../../src/goals/planner.ts';
import type { PlanStep } from '../../src/goals/plan.ts';
import { OBSERVED, type KnownResource } from '../../src/memory/types.ts';
import { agentOwner } from '../../src/persistence/repositories/ledger.ts';
import { Store } from '../../src/persistence/store.ts';

function fixture() {
  const ids = sequentialIdFactory();
  const store = Store.openMemory(ids);
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
    assert.deepEqual(plan.steps[0]?.params, { target: { kind: 'resource', resource: 'food' } });
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
    assert.deepEqual(buildPlan(goal, { ...context, carrying: { food: 2 } }, ids).steps.map(s => s.action), ['eat']);
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

it('explores fresh ground on a later attempt rather than returning to remembered food', () => {
  const { ids, store, goal, context } = fixture();
  try {
    const plan = buildPlan(goal, context, ids, 1);
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
    assert.equal(store.knowledge.knownResources(agent.id, 'food').length, 0);
  } finally { await environment.disconnect(); store.close(); }
});
