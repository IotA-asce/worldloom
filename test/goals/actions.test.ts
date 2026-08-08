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
});
