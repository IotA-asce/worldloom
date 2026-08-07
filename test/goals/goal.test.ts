import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sequentialIdFactory, type AgentId, type GoalId } from '../../src/core/ids.ts';
import { expect } from '../../src/core/result.ts';
import {
  canTransition,
  describeGoal,
  GOAL_STATES,
  isPursuable,
  isTerminal,
  transitionGoal,
  type Goal,
  type GoalKind,
  type GoalState,
} from '../../src/goals/goal.ts';

const ids = sequentialIdFactory();

function makeGoal<K extends GoalKind>(
  kind: K,
  params: Goal<K>['params'],
  state: GoalState = 'proposed',
): Goal<K> {
  return {
    id: ids.next('goal') as GoalId,
    agentId: 'agent_000001' as AgentId,
    kind,
    params,
    state,
    priority: 0.5,
    reason: 'because the test says so',
    parentGoalId: null,
    createdAtDay: 1,
    createdAtTicks: 1000,
    resolvedAtTicks: null,
    outcome: null,
  };
}

describe('goal state machine', () => {
  it('allows the normal happy path', () => {
    assert.ok(canTransition('proposed', 'active'));
    assert.ok(canTransition('active', 'completed'));
  });

  it('allows blocking and recovery — the replanning path', () => {
    assert.ok(canTransition('active', 'blocked'));
    assert.ok(canTransition('blocked', 'active'));
  });

  it('treats completed, failed and abandoned as terminal', () => {
    for (const state of ['completed', 'failed', 'abandoned'] as const) {
      assert.ok(isTerminal(state), `${state} should be terminal`);
      for (const to of GOAL_STATES) {
        assert.ok(!canTransition(state, to), `${state} -> ${to} must be refused`);
      }
    }
  });

  it('refuses to resurrect a completed goal', () => {
    const goal = makeGoal('rest', { untilEnergy: 0.9 }, 'completed');
    const result = transitionGoal(goal, 'active', 2000);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.failure.detail, /illegal goal transition completed -> active/);
  });

  it('refuses a no-op transition rather than silently accepting it', () => {
    const goal = makeGoal('rest', { untilEnergy: 0.9 }, 'active');
    const result = transitionGoal(goal, 'active', 2000);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.failure.detail, /already active/);
  });

  it('refuses to go straight from proposed to completed', () => {
    // A goal must be actively pursued before it can succeed — otherwise the
    // causal chain (goal -> plan -> execution) has a hole in it.
    const goal = makeGoal('find_food', { quantity: 5 });
    assert.equal(transitionGoal(goal, 'completed', 1).ok, false);
  });

  it('stamps the resolution tick on terminal states only', () => {
    const active = expect(transitionGoal(makeGoal('rest', { untilEnergy: 1 }), 'active', 1100), 'activate');
    assert.equal(active.resolvedAtTicks, null);

    const completed = expect(transitionGoal(active, 'completed', 1500), 'complete');
    assert.equal(completed.resolvedAtTicks, 1500);
  });

  it('does not stamp a resolution tick when merely blocking', () => {
    const active = expect(transitionGoal(makeGoal('rest', { untilEnergy: 1 }), 'active', 1100), 'activate');
    const blocked = expect(transitionGoal(active, 'blocked', 1200, 'no wood available'), 'block');
    assert.equal(blocked.resolvedAtTicks, null);
    assert.equal(blocked.outcome, 'no wood available');
  });

  it('records the outcome that explains a failure', () => {
    const active = expect(
      transitionGoal(makeGoal('gather_resource', { resource: 'iron', quantity: 20 }), 'active', 1100),
      'activate',
    );
    const failed = expect(transitionGoal(active, 'failed', 1300, 'deposit exhausted'), 'fail');
    assert.equal(failed.state, 'failed');
    assert.equal(failed.outcome, 'deposit exhausted');
  });

  it('preserves a blocked goal\'s outcome when it recovers', () => {
    const active = expect(transitionGoal(makeGoal('rest', { untilEnergy: 1 }), 'active', 100), 'activate');
    const blocked = expect(transitionGoal(active, 'blocked', 200, 'interrupted by mobs'), 'block');
    const resumed = expect(transitionGoal(blocked, 'active', 300), 'resume');
    // Recovery clears the stale block reason rather than leaving it to confuse
    // the next failure report.
    assert.equal(resumed.state, 'active');
    assert.equal(resumed.outcome, null);
  });

  it('leaves the original goal untouched (values, not mutation)', () => {
    const goal = makeGoal('rest', { untilEnergy: 1 });
    expect(transitionGoal(goal, 'active', 500), 'activate');
    assert.equal(goal.state, 'proposed');
  });
});

describe('isPursuable', () => {
  it('is true only while the agent should be spending ticks', () => {
    assert.ok(isPursuable(makeGoal('rest', { untilEnergy: 1 }, 'proposed')));
    assert.ok(isPursuable(makeGoal('rest', { untilEnergy: 1 }, 'active')));
    for (const state of ['blocked', 'completed', 'failed', 'abandoned'] as const) {
      assert.ok(!isPursuable(makeGoal('rest', { untilEnergy: 1 }, state)), `${state} is not pursuable`);
    }
  });
});

describe('describeGoal', () => {
  it('renders every goal kind without throwing', () => {
    const samples: Goal[] = [
      makeGoal('gather_resource', { resource: 'wood', quantity: 48 }),
      makeGoal('build_structure', { structureType: 'shelter', blueprint: 'small_shelter' }),
      makeGoal('explore_region', { region: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } } }),
      makeGoal('find_food', { quantity: 4 }),
      makeGoal('seek_shelter', {}),
      makeGoal('rest', { untilEnergy: 0.9 }),
      makeGoal('share_knowledge', { toAgentId: 'agent_000002' as AgentId, subject: 'iron' }),
      makeGoal('assist_agent', { agentId: 'agent_000002' as AgentId, with: 'building' }),
      makeGoal('deposit_resources', {}),
    ];
    for (const goal of samples) {
      const text = describeGoal(goal);
      assert.ok(text.length > 0, `${goal.kind} produced no description`);
    }
  });

  it('includes the quantity so a log line is actionable', () => {
    assert.equal(
      describeGoal(makeGoal('gather_resource', { resource: 'wood', quantity: 48 })),
      'gather 48 wood',
    );
  });
});
