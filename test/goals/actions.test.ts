/**
 * Executor-level regressions for the goal actions.
 *
 * The state-machine tests in `goal.test.ts` prove goals move through their
 * states correctly; these prove the steps themselves keep working against a
 * real environment. Each test here exists because a soak failed this way once.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  NEUTRAL_PERSONALITY,
  NO_SKILLS,
  STARTING_NEEDS,
  type Agent,
} from '../../src/agents/agent.ts';
import { sequentialIdFactory, type AgentId } from '../../src/core/ids.ts';
import { position } from '../../src/core/world.ts';
import { flatEnvironment } from '../../src/environment/fake/environment.ts';
import { executeStep } from '../../src/goals/actions.ts';
import type { Goal } from '../../src/goals/goal.ts';
import { buildPlan, type PlanningContext } from '../../src/goals/planner.ts';
import { agentOwner } from '../../src/persistence/repositories/ledger.ts';
import { Store } from '../../src/persistence/store.ts';

function makeAgent(id: AgentId): Agent {
  return {
    id,
    name: 'Arun',
    role: 'Explorer',
    personality: NEUTRAL_PERSONALITY,
    skills: NO_SKILLS,
    needs: STARTING_NEEDS,
    position: position(0, 64, 0),
    health: 1,
    status: 'idle',
    phase: 'act',
    currentGoalId: null,
    lastTickAt: 0,
    activity: '',
    spawnedAtDay: 0,
  };
}

function buildGoal(agentId: AgentId): Goal {
  return {
    id: 'goal_siting' as Goal['id'],
    agentId,
    kind: 'build_structure',
    params: { structureType: 'shelter', blueprint: 'small_shelter' },
    state: 'active',
    priority: 0.9,
    reason: 'test',
    parentGoalId: null,
    createdAtDay: 0,
    createdAtTicks: 0,
    resolvedAtTicks: null,
    outcome: null,
  };
}

describe('select_site', () => {
  async function selectSiteAt(searchRadius: number) {
    const store = Store.openMemory(sequentialIdFactory());
    store.simulation.initialise('siting-test', 1, 1_700_000_000_000);
    const agent = makeAgent('agent_000001' as AgentId);
    store.agents.insert(agent);
    const environment = flatEnvironment();
    await environment.connect();

    const result = await executeStep(
      {
        index: 0,
        action: 'select_site',
        params: { blueprint: 'small_shelter', near: position(0, 64, 0), searchRadius },
        status: 'active',
        attempts: 1,
        failure: null,
        note: null,
      },
      {
        store,
        environment,
        agent: store.agents.get(agent.id),
        goal: buildGoal(agent.id),
        time: store.simulation.currentTime(),
      },
    );
    return { result, store, environment, agent };
  }

  it('still surveys when the search has widened past the fine-resolution limit', async () => {
    // The siting search widens by 60 blocks per attempt. At a fixed resolution
    // of 2, a radius past ~120 blocks asks the environment for more cells than
    // a survey may return — so the late attempts of a long search failed
    // BAD_ARGS without ever looking at the ground. A 30-day soak showed exactly
    // that: seven survey refusals, all from one settler, all at attempt ≥ 2.
    const { result, store, environment, agent } = await selectSiteAt(280);

    assert.ok(result.ok, `a wide survey should be sampled coarsely, not refused: ${
      result.ok === false ? result.failure.detail : ''
    }`);
    assert.match(result.value.note ?? '', /chose a site/);
    assert.equal(
      store.knowledge.knownLocations(agent.id, 'build_site').length,
      1,
      'the site it chose is somewhere it can walk back to',
    );

    await environment.disconnect();
    store.close();
  });

  it('still finds ground when the coarse survey no longer matches the footprint probe', async () => {
    // Coarsening exposed a quieter bug: the footprint probe looked up exact
    // coordinates (0, half, full) in the sampled grid, and past resolution 2
    // those offsets mostly land *between* samples. Every footprint probed fewer
    // than four real heights, so the search returned null however flat the
    // terrain — the widened search failed TARGET_CHANGED on open ground.
    // Radius 160 samples at resolution 3, where not one raw offset lands.
    const { result, store, environment } = await selectSiteAt(160);

    assert.ok(result.ok, `probes must snap to the survey grid: ${
      result.ok === false ? result.failure.detail : ''
    }`);
    assert.match(result.value.note ?? '', /chose a site/);

    await environment.disconnect();
    store.close();
  });

  it('chooses a site flush with the ground, not stacked on it', async () => {
    // The origin becomes the build's base layer. Returned one block above the
    // ground it surveyed, the hut floor stacked *on* the dirt — and wherever
    // the door side fell away by one more, getting in was a two-block climb
    // the walker rightly refuses. A diag world showed what that costs: 509
    // abandoned seek_shelter goals, all ending PATH_BLOCKED at the hut wall.
    const { result, store, environment, agent } = await selectSiteAt(40);

    assert.ok(result.ok, 'siting should succeed on open flat ground');
    const chosen = store.knowledge.knownLocations(agent.id, 'build_site')[0];
    assert.ok(chosen !== undefined, 'the chosen site is on record');
    assert.equal(
      chosen.position.y,
      environment.world.surfaceHeight(chosen.position.x, chosen.position.z),
      'the build origin is the ground level itself, so the floor replaces the top block',
    );

    await environment.disconnect();
    store.close();
  });

  it('refuses a site whose ground falls away beyond the footprint', async () => {
    // A ledge site surveys flat across the footprint and builds fine — but its
    // doorway ends up a two-block climb from outside, the walker refuses it,
    // and the shelter stands unusable. One diag world: 511 seek_shelter goals
    // abandoned PATH_BLOCKED at the hut wall. The ring around the footprint is
    // part of the site.
    const store = Store.openMemory(sequentialIdFactory());
    store.simulation.initialise('siting-test', 1, 1_700_000_000_000);
    const agent = makeAgent('agent_000001' as AgentId);
    store.agents.insert(agent);
    const environment = flatEnvironment();
    await environment.connect();
    const ground = environment.world.terrainHeight(0, 0);

    // A flat-topped platform two blocks up, eight by eight: big enough that a
    // footprint on it reads perfectly flat (and wins the raised-ground
    // preference), small enough that the ring around any such footprint falls
    // two blocks back to the plain.
    for (let px = 8; px <= 15; px++) {
      for (let pz = 8; pz <= 15; pz++) {
        environment.world.setBlock(position(px, ground + 1, pz), { surface: 'stone', yields: 'stone', solid: true });
        environment.world.setBlock(position(px, ground + 2, pz), { surface: 'stone', yields: 'stone', solid: true });
      }
    }

    const result = await executeStep(
      {
        index: 0,
        action: 'select_site',
        params: { blueprint: 'small_shelter', near: position(10, 64, 10), searchRadius: 40 },
        status: 'active',
        attempts: 1,
        failure: null,
        note: null,
      },
      {
        store,
        environment,
        agent: store.agents.get(agent.id),
        goal: buildGoal(agent.id),
        time: store.simulation.currentTime(),
      },
    );

    assert.ok(result.ok, 'open ground surrounds the platform, so siting should succeed');
    const chosen = store.knowledge.knownLocations(agent.id, 'build_site')[0];
    assert.ok(chosen !== undefined, 'the chosen site is on record');
    assert.equal(
      chosen.position.y,
      ground,
      'a flat top ringed by a two-block drop is a ledge, not a site — it chose the honest flat',
    );

    await environment.disconnect();
    store.close();
  });

  it('builds on the claimed site, not on the search anchor', async () => {
    // The plan threads only the *anchor* through reserve/clear/place/verify —
    // the site itself lives in the agent's knowledge. When those steps acted
    // on the anchor, every structure went up on the settlement centre,
    // stacked on top of the first one's walls.
    const store = Store.openMemory(sequentialIdFactory());
    store.simulation.initialise('siting-test', 1, 1_700_000_000_000);
    const agent = makeAgent('agent_000001' as AgentId);
    store.agents.insert(agent);
    const environment = flatEnvironment();
    await environment.connect();
    const goal = buildGoal(agent.id);
    const ctx = {
      store,
      environment,
      agent: store.agents.get(agent.id),
      goal,
      time: store.simulation.currentTime(),
    };

    // The anchor is the agent's own position; the chosen site will be elsewhere.
    const anchor = position(0, 64, 0);
    const sited = await executeStep(
      {
        index: 0,
        action: 'select_site',
        params: { blueprint: 'small_shelter', near: anchor, searchRadius: 40 },
        status: 'active',
        attempts: 1,
        failure: null,
        note: null,
      },
      ctx,
    );
    assert.ok(sited.ok, 'siting should succeed on open flat ground');
    const chosen = store.knowledge.knownLocations(agent.id, 'build_site')[0];
    assert.ok(chosen !== undefined, 'the chosen site is on record');

    // Pay for the build, then place it with `at: 'build_site'` as the plan does.
    store.ledger.credit(agentOwner(agent.id), { wood: 60, stone: 25 });
    const placed = await executeStep(
      {
        index: 4,
        action: 'place_blueprint',
        params: { blueprint: 'small_shelter', origin: anchor, at: 'build_site' },
        status: 'active',
        attempts: 1,
        failure: null,
        note: null,
      },
      ctx,
    );

    assert.ok(placed.ok, `the build should land: ${placed.ok === false ? placed.failure.detail : ''}`);
    const started = store.events.query({ types: ['structure_started'] })[0];
    const built = (started?.payload as { region: { min: { x: number; z: number } } }).region;
    assert.deepEqual(
      { x: built.min.x, z: built.min.z },
      { x: chosen.position.x, z: chosen.position.z },
      'the walls went up on the claimed ground, not on the anchor',
    );

    await environment.disconnect();
    store.close();
  });
});


describe('find_food uses food already carried before searching', () => {
  function foodContext(agent: Agent, food: number, store: Store): PlanningContext {
    return {
      agent, time: store.simulation.currentTime(), knownResources: [], knownShelter: null,
      settlementCenter: null, carrying: food > 0 ? { food } : {}, memories: [], claimedWork: [],
      existingStructures: [], sharedStore: null, work: null, sheltered: false, hostilesNearby: 0,
    };
  }

  for (const { supply, quantity, eaten } of [
    { supply: 5, quantity: 6, eaten: 4 },
    { supply: 1, quantity: 6, eaten: 1 },
    { supply: 5, quantity: 1, eaten: 1 },
  ]) {
    it(`eats ${eaten} from ${supply} carried food with goal quantity ${quantity}`, async () => {
      const ids = sequentialIdFactory();
      const store = Store.openMemory(ids);
      store.simulation.initialise('carried-food-fixture', 1, 1_700_000_000_000);
      const agent = { ...makeAgent('agent_000001' as AgentId),
        needs: { ...STARTING_NEEDS, food: 0.2 } };
      store.agents.insert(agent);
      // Explicit fixture inventory, not a simulated harvest or production credit.
      store.ledger.credit(agentOwner(agent.id), { food: supply });
      const environment = flatEnvironment();
      await environment.connect();
      try {
        const goal: Goal = { ...buildGoal(agent.id), kind: 'find_food', params: { quantity } };
        const context = foodContext(agent, supply, store);
        const plan = buildPlan(goal, context, ids);
        assert.deepEqual(plan.steps.map((step) => step.action), ['eat']);
        const step = plan.steps[0];
        assert.ok(step);
        const result = await executeStep(step, { store, environment, agent, goal, time: context.time });
        assert.ok(result.ok);
        assert.equal(store.ledger.quantity(agentOwner(agent.id), 'food'), supply - eaten);
        assert.ok(Math.abs((result.value.agentPatch?.needs?.food ?? 0) - (0.2 + eaten * 0.15)) < 1e-10);
        const events = store.events.query({ types: ['resource_spent'] });
        assert.equal(events.length, 1);
        assert.deepEqual(events[0]?.payload, { agentId: agent.id, resources: { food: eaten }, reason: 'eating' });
        assert.equal(store.events.query({ types: ['resource_collected'] }).length, 0);
      } finally {
        await environment.disconnect();
        store.close();
      }
    });
  }

  it('keeps discovery and changed-ground retry plans when inventory is empty', () => {
    const ids = sequentialIdFactory();
    const store = Store.openMemory(ids);
    store.simulation.initialise('empty-food-fixture', 1, 1_700_000_000_000);
    try {
      const agent = makeAgent('agent_000001' as AgentId);
      const context = foodContext(agent, 0, store);
      const goal: Goal = { ...buildGoal(agent.id), kind: 'find_food', params: { quantity: 6 } };
      assert.deepEqual(buildPlan(goal, context, ids).steps.map((step) => step.action),
        ['locate_resource', 'travel_to', 'harvest_resource', 'eat']);
      assert.deepEqual(buildPlan(goal, context, ids, 1).steps.map((step) => step.action),
        ['travel_to', 'survey_area', 'locate_resource', 'travel_to', 'harvest_resource', 'eat']);
    } finally {
      store.close();
    }
  });
});
