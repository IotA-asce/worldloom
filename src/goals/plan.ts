/**
 * Plans: structured, inspectable, persisted (requirement 16).
 *
 * A plan is data, not prose. The simulation must always be able to answer what
 * an agent is trying to do, what step it is on, whether it is blocked, and what
 * caused a failure — so all four are fields.
 *
 * Steps name *deterministic* executors. The planner (sometimes a model) decides
 * the sequence; code carries it out (requirement 4).
 */

import type { AgentId, GoalId, PlanId } from '../core/ids.ts';
import type { ActionFailure } from '../core/result.ts';
import type { Position, Region, ResourceKind } from '../core/world.ts';

/**
 * Every action an agent can take. Each maps to one deterministic executor —
 * adding an action means adding an executor, never a prompt.
 */
export const ACTION_KINDS = [
  'survey_area',
  'travel_to',
  'locate_resource',
  'harvest_resource',
  'select_site',
  'reserve_region',
  'clear_site',
  'place_blueprint',
  'verify_structure',
  'release_region',
  'deposit_resources',
  'send_message',
  'rest',
  'eat',
] as const;

export type ActionKind = (typeof ACTION_KINDS)[number];

/**
 * A travel destination that may be resolved at execution time from the agent's
 * own knowledge.
 *
 * This matters for legibility as much as for mechanics: a plan step reading
 * "travel toward the nearest known forest" stays meaningful, whereas one holding
 * coordinates captured at planning time silently goes stale when the agent
 * learns of somewhere better — or when the deposit turns out to be exhausted.
 */
export type TravelTarget =
  | { readonly kind: 'position'; readonly position: Position }
  | { readonly kind: 'resource'; readonly resource: ResourceKind }
  | { readonly kind: 'location'; readonly location: string };

export interface ActionParams {
  survey_area: { region: Region; resolution?: number };
  travel_to: { target: TravelTarget };
  locate_resource: { resource: ResourceKind; searchRadius: number };
  /** `from` is resolved from the agent's known resources when absent. */
  harvest_resource: { resource: ResourceKind; quantity: number; from?: Region };
  select_site: { blueprint: string; near?: Position; searchRadius: number };
  reserve_region: { region: Region };
  clear_site: { region: Region };
  place_blueprint: { blueprint: string; origin: Position };
  verify_structure: { blueprint: string; origin: Position };
  release_region: { region: Region };
  deposit_resources: { resource?: ResourceKind };
  send_message: { toAgentId: AgentId; content: string };
  /** Rest until energy reaches this level. Held across ticks, not instant. */
  rest: { untilEnergy: number };
  eat: { amount: number };
}

export const STEP_STATUSES = ['pending', 'active', 'completed', 'failed', 'skipped'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export interface PlanStep {
  readonly index: number;
  readonly action: ActionKind;
  readonly params: ActionParams[ActionKind];
  readonly status: StepStatus;
  readonly attempts: number;
  /** Why the last attempt failed. Kept even after a later attempt succeeds —
   *  the history of a struggle is worth having. */
  readonly failure: ActionFailure | null;
  /** Free-text result summary, used to build the next step's context. */
  readonly note: string | null;
}

export const PLAN_STATES = ['active', 'completed', 'failed', 'superseded'] as const;
export type PlanState = (typeof PLAN_STATES)[number];

export interface Plan {
  readonly id: PlanId;
  readonly goalId: GoalId;
  readonly agentId: AgentId;
  readonly steps: readonly PlanStep[];
  readonly currentStep: number;
  readonly state: PlanState;
  readonly createdAtTicks: number;
  /** Incremented each time the plan is revised, for traceability. */
  readonly revision: number;
}

/** Default attempts per step before the failure escalates to replanning. */
export const DEFAULT_MAX_ATTEMPTS = 2;

export function makeStep<K extends ActionKind>(
  index: number,
  action: K,
  params: ActionParams[K],
): PlanStep {
  return { index, action, params, status: 'pending', attempts: 0, failure: null, note: null };
}

/** The step the plan is waiting on, or null when there is nothing left to do. */
export function currentStep(plan: Plan): PlanStep | null {
  return plan.steps[plan.currentStep] ?? null;
}

export function isPlanFinished(plan: Plan): boolean {
  return plan.state !== 'active' || plan.currentStep >= plan.steps.length;
}

export function remainingSteps(plan: Plan): readonly PlanStep[] {
  return plan.steps.filter((step) => step.status === 'pending' || step.status === 'active');
}

/** Replace one step, returning a new plan. Steps are immutable values. */
function withStep(plan: Plan, index: number, update: Partial<PlanStep>): Plan {
  const steps = plan.steps.map((step) =>
    step.index === index ? { ...step, ...update } : step,
  );
  return { ...plan, steps };
}

export function markStepActive(plan: Plan, index: number): Plan {
  const step = plan.steps[index];
  if (step === undefined) return plan;
  return withStep(plan, index, { status: 'active', attempts: step.attempts + 1 });
}

/**
 * Complete the current step and advance. When the last step completes the plan
 * completes with it, so a caller never has to check for that separately.
 */
export function completeStep(plan: Plan, index: number, note?: string): Plan {
  const advanced = withStep(plan, index, {
    status: 'completed',
    note: note ?? null,
    failure: null,
  });
  const nextStep = index + 1;
  return {
    ...advanced,
    currentStep: nextStep,
    state: nextStep >= advanced.steps.length ? 'completed' : advanced.state,
  };
}

/**
 * Record a failed attempt. The plan only fails once the step is out of
 * attempts — otherwise it stays active and will be retried, which is the
 * bounded retry of ADR-0008 rather than an unbounded loop.
 */
export function failStep(
  plan: Plan,
  index: number,
  failure: ActionFailure,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
): Plan {
  const step = plan.steps[index];
  if (step === undefined) return plan;

  const exhausted = step.attempts >= maxAttempts || failure.retryable === false;
  const updated = withStep(plan, index, {
    status: exhausted ? 'failed' : 'pending',
    failure,
  });
  return { ...updated, state: exhausted ? 'failed' : updated.state };
}

/** Skip a step that turned out to be unnecessary, e.g. a site already cleared. */
export function skipStep(plan: Plan, index: number, note: string): Plan {
  const skipped = withStep(plan, index, { status: 'skipped', note });
  const nextStep = index + 1;
  return {
    ...skipped,
    currentStep: nextStep,
    state: nextStep >= skipped.steps.length ? 'completed' : skipped.state,
  };
}

/** Insert steps before the current one — how a blocked plan acquires a
 *  prerequisite (e.g. "gather wood first") without discarding its progress. */
export function insertStepsBefore(plan: Plan, index: number, inserted: readonly PlanStep[]): Plan {
  const before = plan.steps.slice(0, index);
  const after = plan.steps.slice(index);
  const steps = [...before, ...inserted, ...after].map((step, i) => ({ ...step, index: i }));
  return { ...plan, steps, revision: plan.revision + 1 };
}

export function planProgress(plan: Plan): { done: number; total: number } {
  const done = plan.steps.filter(
    (step) => step.status === 'completed' || step.status === 'skipped',
  ).length;
  return { done, total: plan.steps.length };
}

export function describeStep(step: PlanStep): string {
  const params = step.params as Record<string, unknown>;
  switch (step.action) {
    case 'harvest_resource':
      return `harvest ${String(params.quantity)} ${String(params.resource)}`;
    case 'locate_resource':
      return `look for ${String(params.resource)}`;
    case 'travel_to':
      return 'travel';
    case 'survey_area':
      return 'survey the area';
    case 'select_site':
      return `choose a site for the ${String(params.blueprint)}`;
    case 'place_blueprint':
      return `construct the ${String(params.blueprint)}`;
    case 'verify_structure':
      return 'check the construction';
    case 'clear_site':
      return 'clear the site';
    case 'reserve_region':
      return 'claim the site';
    case 'release_region':
      return 'release the site';
    case 'deposit_resources':
      return 'deposit resources';
    case 'send_message':
      return 'send word';
    case 'rest':
      return 'rest';
    case 'eat':
      return 'eat';
  }
}

export function describePlan(plan: Plan): string {
  const { done, total } = planProgress(plan);
  const step = currentStep(plan);
  const where = step ? describeStep(step) : 'nothing left to do';
  return `step ${done + 1}/${total}: ${where}`;
}
