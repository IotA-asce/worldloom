/**
 * Goals: what an agent is trying to do, and why.
 *
 * A goal always carries the reason it was chosen. That reason is what makes
 * "why did Mira abandon the farm project?" answerable without reading a model
 * transcript (requirement 31).
 */

import type { AgentId, GoalId } from '../core/ids.ts';
import { fail, ok, type Result } from '../core/result.ts';
import type { Position, Region, ResourceKind } from '../core/world.ts';

export const GOAL_KINDS = [
  'explore_region',
  'gather_resource',
  'build_structure',
  'find_food',
  'seek_shelter',
  'rest',
  'share_knowledge',
  'assist_agent',
  'deposit_resources',
] as const;

export type GoalKind = (typeof GOAL_KINDS)[number];

/** Per-kind parameters. Typed so a goal can't be created without its inputs. */
export interface GoalParams {
  explore_region: { region: Region; reason?: string };
  gather_resource: { resource: ResourceKind; quantity: number };
  build_structure: { structureType: string; blueprint: string; site?: Position };
  find_food: { quantity: number };
  seek_shelter: { before?: number };
  rest: { untilEnergy: number };
  share_knowledge: { toAgentId: AgentId; subject: string };
  assist_agent: { agentId: AgentId; with: string };
  deposit_resources: { resource?: ResourceKind };
}

export const GOAL_STATES = [
  'proposed',
  'active',
  'blocked',
  'completed',
  'failed',
  'abandoned',
] as const;

export type GoalState = (typeof GOAL_STATES)[number];

export const TERMINAL_GOAL_STATES: ReadonlySet<GoalState> = new Set<GoalState>([
  'completed',
  'failed',
  'abandoned',
]);

/**
 * Legal state transitions. Enforced rather than documented, because an agent
 * reviving a completed goal or abandoning a failed one silently corrupts the
 * history the chronicle is built from.
 */
const TRANSITIONS: Readonly<Record<GoalState, readonly GoalState[]>> = {
  proposed: ['active', 'abandoned'],
  // A goal can complete straight from active, or stall into blocked.
  active: ['blocked', 'completed', 'failed', 'abandoned'],
  // Blocked is recoverable — that recovery is requirement 35's replanning criterion.
  blocked: ['active', 'failed', 'abandoned'],
  completed: [],
  failed: [],
  abandoned: [],
};

export interface Goal<K extends GoalKind = GoalKind> {
  readonly id: GoalId;
  readonly agentId: AgentId;
  readonly kind: K;
  readonly params: GoalParams[K];
  readonly state: GoalState;
  /** 0..1. Higher wins when the agent picks what to do next. */
  readonly priority: number;
  /** Why this goal exists. Free text, written by whatever chose it. */
  readonly reason: string;
  /** Set when the goal serves a larger one — the hierarchy of requirement 15. */
  readonly parentGoalId: GoalId | null;
  readonly createdAtDay: number;
  readonly createdAtTicks: number;
  readonly resolvedAtTicks: number | null;
  /** Populated when the goal ends in blocked, failed or abandoned. */
  readonly outcome: string | null;
}

export function canTransition(from: GoalState, to: GoalState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(state: GoalState): boolean {
  return TERMINAL_GOAL_STATES.has(state);
}

/**
 * Apply a state transition, refusing illegal ones. Returns a Result rather
 * than throwing so the caller can record the attempt as a failure event.
 */
export function transitionGoal(
  goal: Goal,
  to: GoalState,
  atTicks: number,
  outcome?: string,
): Result<Goal> {
  if (goal.state === to) {
    return fail('INTERNAL', `goal ${goal.id} is already ${to}`);
  }
  if (!canTransition(goal.state, to)) {
    return fail(
      'INTERNAL',
      `illegal goal transition ${goal.state} -> ${to} for ${goal.kind} (${goal.id})`,
    );
  }
  return ok({
    ...goal,
    state: to,
    resolvedAtTicks: isTerminal(to) ? atTicks : null,
    outcome: outcome ?? (isTerminal(to) || to === 'blocked' ? goal.outcome : null),
  });
}

/** Whether the agent should be spending ticks on this goal. */
export function isPursuable(goal: Goal): boolean {
  return goal.state === 'active' || goal.state === 'proposed';
}

export function describeGoal(goal: Goal): string {
  switch (goal.kind) {
    case 'gather_resource': {
      const params = goal.params as GoalParams['gather_resource'];
      return `gather ${params.quantity} ${params.resource}`;
    }
    case 'build_structure': {
      const params = goal.params as GoalParams['build_structure'];
      return `build ${params.structureType}`;
    }
    case 'explore_region':
      return 'explore unknown territory';
    case 'find_food':
      return 'find food';
    case 'seek_shelter':
      return 'find or build shelter';
    case 'rest':
      return 'rest';
    case 'share_knowledge': {
      const params = goal.params as GoalParams['share_knowledge'];
      return `tell someone about ${params.subject}`;
    }
    case 'assist_agent': {
      const params = goal.params as GoalParams['assist_agent'];
      return `help with ${params.with}`;
    }
    case 'deposit_resources':
      return 'deposit resources at the settlement';
  }
}
