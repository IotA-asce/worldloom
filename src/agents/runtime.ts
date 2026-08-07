/**
 * The agent tick — an explicit state machine (ADR-0001).
 *
 * OBSERVE → INTEGRATE → ASSESS → PLAN → ACT → RECORD
 *
 * The phase lives in a column, not on a call stack, so a process killed mid-tick
 * resumes at the right place rather than restarting the agent's turn. That is
 * the whole reason this is written as a state machine instead of falling out of
 * ordinary control flow.
 *
 * Most ticks pass straight through ASSESS and PLAN: an agent with a healthy plan
 * simply advances one step. The model is consulted only at the exceptions —
 * no active goal, or a plan that failed (requirement 8).
 */

import { agentView, isAlive, type Agent, type TickPhase } from './agent.ts';
import { updateNeeds, type NeedContext } from './needs.ts';
import type { Store } from '../persistence/store.ts';
import type { Environment } from '../environment/port.ts';
import type { Observation } from '../environment/port.ts';
import type { ReasoningProvider } from '../reasoning/provider.ts';
import { type WorldloomConfig } from '../core/config.ts';
import { describeFailure, ok, type ActionFailure, type Result } from '../core/result.ts';
import { formatPosition, type Position, type WorldTime } from '../core/world.ts';
import { executeStep } from '../goals/actions.ts';
import {
  canTransition,
  describeGoal,
  transitionGoal,
  type Goal,
} from '../goals/goal.ts';
import {
  completeStep,
  currentStep,
  describePlan,
  failStep,
  markStepActive,
  skipStep,
  type Plan,
} from '../goals/plan.ts';
import {
  buildPlan,
  describeSituation,
  goalFromChoice,
  GoalChoiceSchema,
  RecoverySchema,
  MAX_PLAN_ATTEMPTS,
  ruleGoalChoice,
  ruleRecovery,
  type PlanningContext,
} from '../goals/planner.ts';
import { agentOwner } from '../persistence/repositories/ledger.ts';
import { OBSERVED } from '../memory/types.ts';
import { placeTag, retrieve, retrievedContents, retrievedIds } from '../memory/retrieval.ts';
import { outcomeTag, reflect, shouldReflect } from '../memory/reflection.ts';
import { consolidate, shouldConsolidate } from '../memory/consolidation.ts';
import type { NewEvent } from '../events/types.ts';

const GOAL_SYSTEM_PROMPT = [
  'You decide what a settler in a survival world does next.',
  'You are given only what this settler personally knows — not what others know.',
  'Choose the single most sensible next goal, and say briefly why in the first person.',
  'Survival comes before construction; construction before exploration.',
  'Do not choose work another settler has already claimed unless nothing else is useful.',
].join(' ');

/** Ticks a single step may spend making partial progress before it is stalled. */
const MAX_STEP_CONTINUATIONS = 8;

const RECOVERY_SYSTEM_PROMPT = [
  'A settler\'s plan has failed. Decide whether to retry the same step, replan the goal,',
  'or abandon the goal entirely. Retrying only helps if the failure was bad luck;',
  'a mistaken belief about the world calls for a replan.',
].join(' ');

export interface TickDeps {
  readonly store: Store;
  readonly environment: Environment;
  readonly reasoning: ReasoningProvider;
  readonly config: WorldloomConfig;
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface TickReport {
  readonly agentId: string;
  readonly phaseAtStart: TickPhase;
  readonly observed: boolean;
  readonly goal: Goal | null;
  readonly plan: Plan | null;
  readonly action: string | null;
  readonly note: string | null;
  readonly failure: ActionFailure | null;
  /** True when the model was consulted this tick. */
  readonly reasoned: boolean;
}

/**
 * Run one tick for one agent.
 *
 * Returns a report rather than throwing: a tick that goes badly is a recorded
 * outcome, which is what makes a long run debuggable.
 */
export async function tickAgent(agentId: Agent['id'], deps: TickDeps): Promise<Result<TickReport>> {
  const { store } = deps;
  const agent = store.agents.get(agentId);
  const phaseAtStart = agent.phase;

  if (!isAlive(agent)) {
    return ok(emptyReport(agent, 'dead'));
  }

  // ── OBSERVE ───────────────────────────────────────────────────────────────
  // One reading of the world per tick: the observation already carries the time,
  // so asking separately would both cost a round trip and double-count elapsed
  // time in environments whose clock advances per query.
  const observation = await deps.environment.observe(
    agentView(agent),
    deps.environment.describe().observationRadius,
  );

  if (!observation.ok) {
    // Without observation there is nothing honest to decide on, so the tick
    // stops here rather than acting on stale beliefs.
    store.agents.update({ ...agent, phase: 'observe', activity: 'unable to see anything' });
    return ok({ ...emptyReport(agent, null), failure: observation.failure });
  }

  // The environment reports a wrapping daily clock; the repository folds it into
  // monotonic world time (ADR-0011).
  const time = store.simulation.advanceClock(
    observation.value.time.totalTicks % 24_000,
    observation.value.time.weather,
  );

  // ── INTEGRATE ─────────────────────────────────────────────────────────────
  const integrated = integrate(agent, observation.value, time, deps);
  store.agents.update(integrated);

  // ── ASSESS ────────────────────────────────────────────────────────────────
  const assessed = assessGoal(integrated, deps);
  let goal = assessed.goal;
  let plan = assessed.plan;
  let reasoned = false;

  // ── PLAN ──────────────────────────────────────────────────────────────────
  if (goal === null) {
    const chosen = await chooseGoal(integrated, observation.value, time, deps);
    goal = chosen.goal;
    plan = chosen.plan;
    reasoned = chosen.reasoned;
  }

  if (goal === null || plan === null) {
    store.agents.update({ ...integrated, phase: 'assess', activity: 'considering what to do' });
    return ok({ ...emptyReport(integrated, 'nothing to do'), reasoned });
  }

  // ── ACT ───────────────────────────────────────────────────────────────────
  const step = currentStep(plan);
  if (step === null) {
    // The plan ran out — the goal is done.
    finishGoal(goal, plan, time, deps, 'completed');
    store.agents.update({ ...integrated, phase: 'observe', currentGoalId: null, status: 'idle' });
    return ok({ ...emptyReport(integrated, 'goal complete'), goal, plan, reasoned });
  }

  store.agents.update({ ...integrated, phase: 'act', currentGoalId: goal.id });
  plan = markStepActive(plan, step.index);
  store.plans.update(plan);

  const outcome = await executeStep(plan.steps[step.index]!, {
    store,
    environment: deps.environment,
    agent: integrated,
    goal,
    time,
  });

  // ── RECORD ────────────────────────────────────────────────────────────────
  if (outcome.ok && outcome.value.incomplete === true) {
    // Progress without completion: keep the step current and carry on next tick.
    // Bounded, so a step that inches along forever still eventually fails.
    const result = outcome.value;
    const attempts = plan.steps[step.index]?.attempts ?? 0;

    if (attempts >= MAX_STEP_CONTINUATIONS) {
      const stalled: ActionFailure = {
        kind: 'PATH_BLOCKED',
        detail: `still not there after ${attempts} attempts`,
      };
      const recovery = await recoverFrom(integrated, goal, plan, step.index, stalled, time, deps);
      return {
        ...ok({
          agentId: integrated.id,
          phaseAtStart,
          observed: true,
          goal: recovery.goal,
          plan: recovery.plan,
          action: step.action,
          note: null,
          failure: stalled,
          reasoned: reasoned || recovery.reasoned,
        }),
      };
    }

    const after: Agent = {
      ...integrated,
      ...(result.agentPatch ?? {}),
      // `integrated` predates the ACT-phase write, so the goal has to be carried
      // forward explicitly — otherwise the agent forgets what it was doing and
      // re-decides every tick.
      currentGoalId: goal.id,
      phase: 'observe',
    };
    store.transaction(() => {
      store.agents.update(after);
      store.plans.update({
        ...plan!,
        steps: plan!.steps.map((candidate) =>
          candidate.index === step.index ? { ...candidate, note: result.note } : candidate,
        ),
      });
    });

    deps.log?.(`${integrated.name}: ${result.note}`, { agent: integrated.id, goal: goal.kind });
    return ok({
      agentId: integrated.id,
      phaseAtStart,
      observed: true,
      goal,
      plan,
      action: step.action,
      note: result.note,
      failure: null,
      reasoned,
    });
  }

  if (outcome.ok) {
    const result = outcome.value;
    plan = result.skipped === true
      ? skipStep(plan, step.index, result.note)
      : completeStep(plan, step.index, result.note);

    let after: Agent = {
      ...integrated,
      ...(result.agentPatch ?? {}),
      currentGoalId: goal.id,
      phase: 'observe',
    };

    store.transaction(() => {
      store.plans.update(plan!);
      store.agents.update(after);
      rememberStep(integrated, goal!, { succeeded: true, note: result.note }, time, deps);
    });

    if (plan.state === 'completed') {
      finishGoal(goal, plan, time, deps, 'completed');
      after = { ...after, currentGoalId: null, status: 'idle' };
      store.agents.update(after);
    }

    deps.log?.(`${integrated.name}: ${result.note}`, { agent: integrated.id, goal: goal.kind });
    await tendMemory(after, time, deps);
    return ok({
      agentId: integrated.id,
      phaseAtStart,
      observed: true,
      goal,
      plan,
      action: step.action,
      note: result.note,
      failure: null,
      reasoned,
    });
  }

  // The step failed. Record it, then decide what to do about it — the
  // replanning path of requirement 35.
  const failure = outcome.failure;
  const recovery = await recoverFrom(integrated, goal, plan, step.index, failure, time, deps);

  deps.log?.(`${integrated.name} failed: ${describeFailure(failure)} → ${recovery.action}`, {
    agent: integrated.id,
    goal: goal.kind,
  });
  // A run of failures is exactly what reflection should generalise from.
  await tendMemory(integrated, time, deps);

  return ok({
    agentId: integrated.id,
    phaseAtStart,
    observed: true,
    goal: recovery.goal,
    plan: recovery.plan,
    action: step.action,
    note: null,
    failure,
    reasoned: reasoned || recovery.reasoned,
  });
}

// ── Phases ──────────────────────────────────────────────────────────────────

/** Fold observation into needs and knowledge. No model involved. */
function integrate(
  agent: Agent,
  observation: Observation,
  time: WorldTime,
  deps: TickDeps,
): Agent {
  const elapsedTicks = Math.max(0, time.totalTicks - agent.lastTickAt);
  const hostiles = observation.nearbyEntities.filter((entity) => entity.hostile).length;

  const context: NeedContext = {
    elapsedTicks,
    phase: time.phase,
    isDay: time.isDay,
    sheltered: observation.sheltered,
    hostilesNearby: hostiles,
    companionsNearby: observation.nearbyAgents.length,
    resting: agent.status === 'resting',
  };

  const needs = updateNeeds(agent.needs, context);
  const events: NewEvent[] = [];

  // A need crossing into crisis is worth recording — it explains the goal change
  // that follows on the next tick.
  for (const kind of ['food', 'safety', 'shelter', 'energy'] as const) {
    if (needs[kind] <= 0.2 && agent.needs[kind] > 0.2) {
      events.push({
        type: 'need_critical',
        actorId: agent.id,
        payload: { agentId: agent.id, need: kind, value: needs[kind] },
      });
    }
  }

  deps.store.transaction(() => {
    // Remember whoever was seen, so relationships have something to build on.
    for (const nearby of observation.nearbyAgents) {
      deps.store.knowledge.rememberLocation({
        agentId: agent.id,
        position: nearby.position,
        kind: 'landmark',
        confidence: 0.6,
        source: OBSERVED,
        label: `where I last saw ${nearby.name}`,
        discoveredAtDay: time.day,
        lastSeenAtTicks: time.totalTicks,
      });
    }
    if (events.length > 0) {
      deps.store.events.appendAll(events, { day: time.day, worldTicks: time.totalTicks });
    }
  });

  return { ...agent, needs, lastTickAt: time.totalTicks, phase: 'integrate' };
}

/**
 * Is the current goal still worth pursuing? Returns the goal and plan to
 * continue with, or nulls when a fresh decision is needed.
 */
function assessGoal(agent: Agent, deps: TickDeps): { goal: Goal | null; plan: Plan | null } {
  if (agent.currentGoalId === null) return { goal: null, plan: null };

  const goal = deps.store.goals.find(agent.currentGoalId);
  if (goal === null || goal.state === 'completed' || goal.state === 'failed' || goal.state === 'abandoned') {
    return { goal: null, plan: null };
  }
  if (goal.state === 'blocked') {
    return { goal: null, plan: null };
  }

  const plan = deps.store.plans.activeForGoal(goal.id);
  if (plan === null || plan.state !== 'active') return { goal: null, plan: null };

  return { goal, plan };
}

/** Choose a new goal. This is one of the few places the model is consulted. */
async function chooseGoal(
  agent: Agent,
  observation: Observation,
  time: WorldTime,
  deps: TickDeps,
): Promise<{ goal: Goal | null; plan: Plan | null; reasoned: boolean }> {
  // Retrieve once and reuse: the decision row must cite the same memories the
  // prompt was built from, and re-running retrieval would also double-count
  // access, quietly inflating how useful those memories look.
  const retrievedForDecision = retrieveForDecision(agent, observation, time, deps);
  const context = planningContext(agent, observation, time, deps, retrievedForDecision);
  const prompt = describeSituation(context);

  const answer = await deps.reasoning.reason({
    category: 'goal_selection',
    agentId: agent.id,
    system: GOAL_SYSTEM_PROMPT,
    prompt,
    schema: GoalChoiceSchema,
    fallback: () => ruleGoalChoice(context),
  });

  if (!answer.ok) {
    return { goal: null, plan: null, reasoned: false };
  }

  const choice = answer.value.value;
  const goal = goalFromChoice(choice, context, deps.store.ids);
  const activated = transitionGoal(goal, 'active', time.totalTicks);
  const active = activated.ok ? activated.value : goal;
  const plan = buildPlan(active, context, deps.store.ids);

  deps.store.transaction(() => {
    deps.store.goals.insert(active);
    deps.store.plans.insert(plan);
    deps.store.events.appendAll(
      [
        {
          type: 'goal_created',
          actorId: agent.id,
          payload: {
            agentId: agent.id,
            goalId: active.id,
            kind: active.kind,
            reason: active.reason,
            priority: active.priority,
          },
        },
        {
          type: 'plan_created',
          actorId: agent.id,
          payload: {
            agentId: agent.id,
            goalId: active.id,
            planId: plan.id,
            steps: plan.steps.length,
          },
        },
      ],
      { day: time.day, worldTicks: time.totalTicks },
    );

    // The decision's inputs are persisted so "why did she choose that?" is a
    // query, not archaeology (ADR-0008).
    if (deps.config.logging.record_decisions) {
      deps.store.decisions.record({
        agentId: agent.id,
        category: 'goal_selection',
        worldTicks: time.totalTicks,
        day: time.day,
        observation: {
          position: agent.position,
          needs: agent.needs,
          phase: time.phase,
          sheltered: observation.sheltered,
          visibleResources: observation.visibleResources.slice(0, 6),
          knownResources: context.knownResources.length,
          claimedWork: context.claimedWork,
        },
        memoryIds: retrievedIds(retrievedForDecision),
        prompt: answer.value.prompt,
        response: answer.value.raw,
        model: answer.value.model,
        chosenAction: `${active.kind}: ${active.reason}`,
        eventId: null,
        llmCallId: null,
      });
    }
  });

  deps.log?.(`${agent.name} decided to ${describeGoal(active)} — ${active.reason}`, {
    agent: agent.id,
    source: answer.value.source,
  });

  return { goal: active, plan, reasoned: answer.value.source === 'model' };
}

/** Decide what to do about a failed step, and apply it. */
async function recoverFrom(
  agent: Agent,
  goal: Goal,
  plan: Plan,
  stepIndex: number,
  failure: ActionFailure,
  time: WorldTime,
  deps: TickDeps,
): Promise<{
  goal: Goal | null;
  plan: Plan | null;
  reasoned: boolean;
  /** What was decided, for the log line. */
  action: 'retry' | 'replan' | 'abandon';
}> {
  const step = plan.steps[stepIndex]!;
  const attempts = step.attempts;

  // A partial move reports PATH_BLOCKED but did make progress; keep the ground
  // the agent covered rather than discarding it.
  const observed = failure.observed as { agentPatch?: Partial<Agent> } | undefined;
  if (observed?.agentPatch !== undefined) {
    deps.store.agents.update({ ...agent, ...observed.agentPatch, phase: 'observe' });
  }

  let failedPlan = failStep(plan, stepIndex, failure);
  deps.store.transaction(() => {
    deps.store.plans.update(failedPlan);
    // The failure becomes a memory as well as an event, so the agent can learn
    // from it rather than only the developer reading the ledger.
    rememberStep(
      agent,
      goal,
      { succeeded: false, note: `${describeFailure(failure)} at ${formatPosition(agent.position)}` },
      time,
      deps,
    );
    deps.store.events.appendAll(
      [
        {
          type: 'action_failed',
          actorId: agent.id,
          payload: {
            agentId: agent.id,
            action: step.action,
            failureKind: failure.kind,
            detail: failure.detail,
          },
        },
      ],
      { day: time.day, worldTicks: time.totalTicks },
    );
  });

  // Still has attempts left: leave the plan alone and try again next tick.
  if (failedPlan.state === 'active') {
    return { goal, plan: failedPlan, reasoned: false, action: 'retry' };
  }

  // Goal-level attempts, not step-level: a replan resets the step's counter, so
  // counting steps alone would let a goal loop forever.
  const planAttempts = deps.store.plans.historyForGoal(goal.id).length;

  const answer = await deps.reasoning.reason({
    category: 'replanning',
    agentId: agent.id,
    system: RECOVERY_SYSTEM_PROMPT,
    prompt: [
      `You are ${agent.name}. Your goal: ${describeGoal(goal)} (${goal.reason}).`,
      `Plan progress: ${describePlan(failedPlan)}.`,
      `The step "${step.action}" failed: ${describeFailure(failure)}.`,
      `You have tried it ${attempts} time(s), across ${planAttempts} plan(s) for this goal.`,
    ].join('\n'),
    schema: RecoverySchema,
    fallback: () => ruleRecovery(agent, failure.kind, attempts, planAttempts),
  });

  let recovery = answer.ok
    ? answer.value.value
    : ruleRecovery(agent, failure.kind, attempts, planAttempts);

  // Whatever the model says, a goal that has already had its allowance of plans
  // is abandoned. Otherwise a genuinely impossible goal loops indefinitely.
  if (recovery.action !== 'abandon' && planAttempts >= MAX_PLAN_ATTEMPTS) {
    recovery = {
      action: 'abandon',
      reason: `after ${planAttempts} attempts this is not achievable from here`,
    };
  }
  const reasoned = answer.ok && answer.value.source === 'model';

  if (recovery.action === 'abandon') {
    finishGoal(goal, failedPlan, time, deps, 'abandoned', recovery.reason);
    deps.store.agents.update({ ...agent, currentGoalId: null, status: 'idle', phase: 'observe' });
    return { goal: null, plan: null, reasoned, action: 'abandon' };
  }

  if (recovery.action === 'replan') {
    // Rebuild from the agent's *current* knowledge, which the failure has just
    // corrected — so the new plan doesn't repeat the same mistake.
    const context = planningContextFromStore(agent, time, deps);
    deps.store.plans.supersedeForGoal(goal.id);
    // The attempt number changes the plan's shape — see buildPlan.
    const revised = buildPlan(goal, context, deps.store.ids, planAttempts);
    deps.store.transaction(() => {
      deps.store.plans.insert(revised);
      deps.store.events.appendAll(
        [
          {
            type: 'plan_revised',
            actorId: agent.id,
            payload: {
              agentId: agent.id,
              planId: revised.id,
              reason: recovery.reason,
              steps: revised.steps.length,
            },
          },
        ],
        { day: time.day, worldTicks: time.totalTicks },
      );
    });
    return { goal, plan: revised, reasoned, action: 'replan' };
  }

  // retry: reopen the step for another attempt next tick.
  failedPlan = { ...failedPlan, state: 'active' };
  deps.store.plans.update(failedPlan);
  return { goal, plan: failedPlan, reasoned, action: 'retry' };
}

function finishGoal(
  goal: Goal,
  plan: Plan,
  time: WorldTime,
  deps: TickDeps,
  state: 'completed' | 'failed' | 'abandoned',
  reason?: string,
): void {
  if (!canTransition(goal.state, state)) return;
  const moved = transitionGoal(goal, state, time.totalTicks, reason);
  if (!moved.ok) return;

  deps.store.transaction(() => {
    deps.store.goals.update(moved.value);
    deps.store.plans.update({ ...plan, state: state === 'completed' ? 'completed' : 'failed' });

    const event: NewEvent =
      state === 'completed'
        ? {
            type: 'goal_completed',
            actorId: goal.agentId,
            payload: { agentId: goal.agentId, goalId: goal.id, kind: goal.kind },
          }
        : state === 'abandoned'
          ? {
              type: 'goal_abandoned',
              actorId: goal.agentId,
              payload: {
                agentId: goal.agentId,
                goalId: goal.id,
                kind: goal.kind,
                reason: reason ?? 'no longer worth doing',
              },
            }
          : {
              type: 'goal_failed',
              actorId: goal.agentId,
              payload: {
                agentId: goal.agentId,
                goalId: goal.id,
                kind: goal.kind,
                reason: reason ?? 'the plan could not be carried out',
              },
            };

    deps.store.events.appendAll([event], { day: time.day, worldTicks: time.totalTicks });
  });
}

/**
 * Store what happened as an episodic memory, so it can influence later decisions.
 *
 * **Failures are remembered as carefully as successes.** An agent that only
 * remembers what worked cannot learn to avoid barren ground, which would make
 * requirement 35's memory criterion vacuous — the interesting case is precisely
 * "I dug here before and found nothing".
 *
 * The tags are what make a memory findable again: the goal kind, an outcome tag
 * that reflection can generalise over, and a quantised place handle so
 * considering the same ground later surfaces what happened on it.
 */
function rememberStep(
  agent: Agent,
  goal: Goal,
  outcome: { succeeded: boolean; note: string },
  time: WorldTime,
  deps: TickDeps,
): void {
  const content = outcome.succeeded
    ? `While trying to ${describeGoal(goal)}, I ${outcome.note}.`
    : `I tried to ${describeGoal(goal)} but ${outcome.note}.`;

  deps.store.memories.insert(
    {
      agentId: agent.id,
      type: 'episodic',
      content,
      // A failure is worth more than a routine success: it is the thing worth
      // not repeating.
      importance: outcome.succeeded ? 0.35 : 0.5,
      source: OBSERVED,
      tags: [placeTag(agent.position), goal.kind, outcomeTag(outcome.succeeded)],
      relatedEntities: [goal.id],
    },
    { day: time.day, worldTicks: time.totalTicks },
  );
}

// ── Context assembly ────────────────────────────────────────────────────────

function planningContext(
  agent: Agent,
  observation: Observation,
  time: WorldTime,
  deps: TickDeps,
  retrieved: ReturnType<typeof retrieve>,
): PlanningContext {
  const shelter = deps.store.knowledge.nearestLocation(agent.id, 'shelter', agent.position);

  return {
    agent,
    time,
    knownResources: deps.store.knowledge.knownResources(agent.id),
    knownShelter: shelter?.position ?? null,
    settlementCenter: settlementCenter(deps),
    carrying: deps.store.ledger.balance(agentOwner(agent.id)),
    memories: retrievedContents(retrieved),
    claimedWork: claimedWork(agent, deps),
    existingStructures: existingStructures(deps),
    sheltered: observation.sheltered,
    hostilesNearby: observation.nearbyEntities.filter((entity) => entity.hostile).length,
  };
}

/**
 * Reflection and consolidation, run at the end of a tick.
 *
 * Both self-gate on their thresholds, so calling this every tick costs a cheap
 * count query in the common case. Keeping it here rather than on a day boundary
 * means an agent that has just had an eventful stretch generalises from it while
 * the episodes are still fresh.
 *
 * Failures here are deliberately swallowed: an agent that cannot tidy its own
 * memory should keep living, and the reason is already on the returned report.
 */
async function tendMemory(agent: Agent, time: WorldTime, deps: TickDeps): Promise<void> {
  const identity = { id: agent.id, name: agent.name };

  if (shouldReflect(deps.store, agent.id, deps.config.memory.reflection_interval)) {
    const reflected = await reflect({
      store: deps.store,
      reasoning: deps.reasoning,
      agent: identity,
      time,
    });
    if (reflected.ok && reflected.value.belief !== null) {
      deps.log?.(`${agent.name} came to believe: ${reflected.value.belief.content}`, {
        agent: agent.id,
      });
    }
  }

  if (shouldConsolidate(deps.store, agent.id, deps.config.memory.consolidation_threshold)) {
    const report = await consolidate({
      store: deps.store,
      reasoning: deps.reasoning,
      agent: identity,
      time,
    });
    if (report.ok && report.value.ran) {
      deps.log?.(
        `${agent.name} sorted through their memories ` +
          `(${report.value.merged.length} merged, ${report.value.forgotten} forgotten)`,
        { agent: agent.id },
      );
    }
  }
}

/**
 * Retrieve the memories relevant to *this* decision.
 *
 * The query is built from where the agent is and what it can see, so considering
 * the same ground again surfaces what happened there last time. Retrieving the
 * most important memories regardless of situation would return the same handful
 * for every decision, which is the behaviour the retrieval module exists to
 * replace (requirement 11).
 */
function retrieveForDecision(
  agent: Agent,
  observation: Observation,
  time: WorldTime,
  deps: TickDeps,
): ReturnType<typeof retrieve> {
  const visible = [...new Set(observation.visibleResources.map((seen) => seen.resource))];
  return retrieve(
    deps.store,
    agent.id,
    {
      tags: [placeTag(agent.position), ...visible],
      entities: observation.nearbyAgents.map((nearby) => nearby.name),
      text: `${agent.role} at ${formatPosition(agent.position)} considering what to do`,
    },
    { limit: deps.config.memory.retrieval_limit, atTicks: time.totalTicks },
  );
}

/** Context without a fresh observation, for replanning within a tick. */
function planningContextFromStore(agent: Agent, time: WorldTime, deps: TickDeps): PlanningContext {
  const shelter = deps.store.knowledge.nearestLocation(agent.id, 'shelter', agent.position);
  return {
    agent,
    time,
    knownResources: deps.store.knowledge.knownResources(agent.id),
    knownShelter: shelter?.position ?? null,
    settlementCenter: settlementCenter(deps),
    carrying: deps.store.ledger.balance(agentOwner(agent.id)),
    memories: [],
    claimedWork: claimedWork(agent, deps),
    existingStructures: existingStructures(deps),
    sheltered: agent.needs.shelter > 0.9,
    hostilesNearby: 0,
  };
}

/**
 * What other agents are visibly working on.
 *
 * This is deliberately shallow: goal *kinds*, not other agents' beliefs, plans,
 * or memories. Announced intent is public; a mind is not (ADR-0007).
 */
function claimedWork(agent: Agent, deps: TickDeps): string[] {
  const out: string[] = [];
  for (const goal of deps.store.goals.allActive()) {
    if (goal.agentId === agent.id) continue;
    out.push(goal.kind);
    if (goal.kind === 'build_structure') {
      const params = goal.params as { blueprint?: string };
      if (params.blueprint !== undefined) out.push(`build:${params.blueprint}`);
    }
  }
  return out;
}

/** Structure types the settlement has, from the ledger of completed builds. */
function existingStructures(deps: TickDeps): string[] {
  const events = deps.store.events.query({ types: ['structure_completed'] });
  const types = new Set<string>();
  for (const event of events) {
    const payload = event.payload as { type?: string };
    if (payload.type !== undefined) types.add(payload.type);
  }
  return [...types];
}

/** The settlement's centre, taken from its founding event. */
function settlementCenter(deps: TickDeps): Position | null {
  const founded = deps.store.events.query({ types: ['settlement_founded'], limit: 1 })[0];
  if (founded === undefined) return null;
  const payload = founded.payload as { center?: Position };
  return payload.center ?? null;
}

function emptyReport(agent: Agent, note: string | null): TickReport {
  return {
    agentId: agent.id,
    phaseAtStart: agent.phase,
    observed: false,
    goal: null,
    plan: null,
    action: null,
    note,
    failure: null,
    reasoned: false,
  };
}

/** Exported for the CLI's status line. */
export function describeAgentState(agent: Agent, goal: Goal | null, plan: Plan | null): string {
  const where = formatPosition(agent.position);
  const doing = goal === null ? agent.activity || 'idle' : describeGoal(goal);
  const progress = plan === null ? '' : ` (${describePlan(plan)})`;
  return `${agent.name} — ${agent.status} at ${where}: ${doing}${progress}`;
}

