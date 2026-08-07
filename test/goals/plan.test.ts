import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AgentId, GoalId, PlanId } from '../../src/core/ids.ts';
import { fail, type ActionFailure } from '../../src/core/result.ts';
import {
  completeStep,
  currentStep,
  describePlan,
  failStep,
  insertStepsBefore,
  isPlanFinished,
  makeStep,
  markStepActive,
  planProgress,
  remainingSteps,
  skipStep,
  type Plan,
} from '../../src/goals/plan.ts';

function failure(kind: Parameters<typeof fail>[0], detail: string, retryable?: boolean): ActionFailure {
  const result = retryable === undefined ? fail(kind, detail) : fail(kind, detail, { retryable });
  if (result.ok) throw new Error('unreachable');
  return result.failure;
}

/** A three-step gather-and-build plan, the shape M1 actually runs. */
function makePlan(): Plan {
  return {
    id: 'plan_000001' as PlanId,
    goalId: 'goal_000001' as GoalId,
    agentId: 'agent_000001' as AgentId,
    steps: [
      makeStep(0, 'locate_resource', { resource: 'wood', searchRadius: 48 }),
      makeStep(1, 'harvest_resource', { resource: 'wood', quantity: 12 }),
      makeStep(2, 'place_blueprint', { blueprint: 'small_shelter', origin: { x: 0, y: 64, z: 0 } }),
    ],
    currentStep: 0,
    state: 'active',
    createdAtTicks: 1000,
    revision: 0,
  };
}

describe('plan progression', () => {
  it('starts on the first step', () => {
    const plan = makePlan();
    assert.equal(currentStep(plan)?.action, 'locate_resource');
    assert.deepEqual(planProgress(plan), { done: 0, total: 3 });
    assert.ok(!isPlanFinished(plan));
  });

  it('counts an attempt when a step becomes active', () => {
    const plan = markStepActive(makePlan(), 0);
    assert.equal(plan.steps[0]?.status, 'active');
    assert.equal(plan.steps[0]?.attempts, 1);
  });

  it('advances on completion and records the note', () => {
    const plan = completeStep(makePlan(), 0, 'found oaks to the north');
    assert.equal(plan.currentStep, 1);
    assert.equal(plan.steps[0]?.status, 'completed');
    assert.equal(plan.steps[0]?.note, 'found oaks to the north');
    assert.equal(currentStep(plan)?.action, 'harvest_resource');
    assert.equal(plan.state, 'active');
  });

  it('completes the plan when the last step completes', () => {
    let plan = makePlan();
    plan = completeStep(plan, 0);
    plan = completeStep(plan, 1);
    plan = completeStep(plan, 2);
    assert.equal(plan.state, 'completed');
    assert.ok(isPlanFinished(plan));
    assert.equal(currentStep(plan), null);
    assert.deepEqual(planProgress(plan), { done: 3, total: 3 });
  });

  it('clears a stale failure when a retry succeeds', () => {
    let plan = markStepActive(makePlan(), 0);
    plan = failStep(plan, 0, failure('TIMEOUT', 'survey timed out'));
    assert.notEqual(plan.steps[0]?.failure, null);

    plan = markStepActive(plan, 0);
    plan = completeStep(plan, 0, 'second attempt worked');
    assert.equal(plan.steps[0]?.failure, null);
    assert.equal(plan.state, 'active');
  });

  it('skips a step that turned out to be unnecessary', () => {
    const plan = skipStep(makePlan(), 0, 'already knew where the oaks were');
    assert.equal(plan.steps[0]?.status, 'skipped');
    assert.equal(plan.currentStep, 1);
    // Skipped counts as progress, not as work outstanding.
    assert.deepEqual(planProgress(plan), { done: 1, total: 3 });
    assert.equal(remainingSteps(plan).length, 2);
  });
});

describe('bounded retries', () => {
  it('keeps the step pending while attempts remain', () => {
    let plan = markStepActive(makePlan(), 1);
    plan = failStep(plan, 1, failure('RESOURCE_UNAVAILABLE', 'tree gone'));
    assert.equal(plan.steps[1]?.status, 'pending');
    assert.equal(plan.state, 'active', 'plan should survive a first failure');
    assert.equal(plan.steps[1]?.failure?.kind, 'RESOURCE_UNAVAILABLE');
  });

  it('fails the plan once the step is out of attempts', () => {
    let plan = makePlan();
    // Two attempts is the default ceiling; the second failure escalates.
    plan = markStepActive(plan, 1);
    plan = failStep(plan, 1, failure('RESOURCE_UNAVAILABLE', 'tree gone'));
    plan = markStepActive(plan, 1);
    plan = failStep(plan, 1, failure('RESOURCE_UNAVAILABLE', 'still gone'));

    assert.equal(plan.steps[1]?.status, 'failed');
    assert.equal(plan.state, 'failed');
    assert.equal(plan.steps[1]?.attempts, 2);
  });

  it('escalates immediately when a failure is explicitly not retryable', () => {
    // Retrying an unaffordable build cannot help; the planner must see it now.
    let plan = markStepActive(makePlan(), 2);
    plan = failStep(plan, 2, failure('INSUFFICIENT_RESOURCES', 'short of 8 wood', false));
    assert.equal(plan.steps[2]?.status, 'failed');
    assert.equal(plan.state, 'failed');
  });

  it('respects a custom attempt ceiling', () => {
    let plan = markStepActive(makePlan(), 0);
    plan = failStep(plan, 0, failure('TIMEOUT', 'slow'), 1);
    assert.equal(plan.state, 'failed', 'one attempt allowed means the first failure is final');
  });

  it('ignores a failure for a step index that does not exist', () => {
    const plan = makePlan();
    assert.deepEqual(failStep(plan, 99, failure('INTERNAL', 'nonsense')), plan);
    assert.deepEqual(markStepActive(plan, 99), plan);
  });
});

describe('replanning by insertion', () => {
  it('inserts prerequisite steps and reindexes without losing progress', () => {
    let plan = completeStep(makePlan(), 0, 'located oaks');
    assert.equal(plan.currentStep, 1);

    // The harvest needs a journey first — insert it ahead of the current step.
    plan = insertStepsBefore(plan, 1, [
      makeStep(0, 'travel_to', { target: { kind: 'position', position: { x: 120, y: 70, z: -40 } } }),
    ]);

    assert.equal(plan.steps.length, 4);
    assert.deepEqual(
      plan.steps.map((step) => step.action),
      ['locate_resource', 'travel_to', 'harvest_resource', 'place_blueprint'],
    );
    // Indices are rewritten to stay consistent with array position.
    assert.deepEqual(plan.steps.map((step) => step.index), [0, 1, 2, 3]);
    // The completed step keeps its status; the inserted step is next.
    assert.equal(plan.steps[0]?.status, 'completed');
    assert.equal(currentStep(plan)?.action, 'travel_to');
    assert.equal(plan.revision, 1);
  });

  it('bumps the revision each time, so the audit trail is ordered', () => {
    let plan = makePlan();
    plan = insertStepsBefore(plan, 0, [makeStep(0, 'rest', { untilEnergy: 0.9 })]);
    plan = insertStepsBefore(plan, 0, [makeStep(0, 'eat', { amount: 1 })]);
    assert.equal(plan.revision, 2);
  });
});

describe('describePlan', () => {
  it('reads as a status line', () => {
    assert.equal(describePlan(makePlan()), 'step 1/3: look for wood');
    assert.equal(describePlan(completeStep(makePlan(), 0)), 'step 2/3: harvest 12 wood');
  });

  it('handles a finished plan', () => {
    let plan = makePlan();
    for (let i = 0; i < 3; i++) plan = completeStep(plan, i);
    assert.match(describePlan(plan), /nothing left to do/);
  });
});
