/**
 * Goal selection and plan construction.
 *
 * The division of labour between model and code is the point of this file:
 *
 *  - **Choosing** a goal can use the model, because weighing hunger against a
 *    half-built shelter against a rumour of iron is judgement.
 *  - **Planning** a chosen goal is deterministic. There is no interesting
 *    freedom in "to gather wood, find wood then harvest it", and a model asked
 *    to emit those steps would only occasionally invent an invalid one.
 *
 * So `selectGoal` is model-gated with a rule fallback, and `buildPlan` is plain
 * code (requirement 4).
 */

import { z } from 'zod';
import type { Agent } from '../agents/agent.ts';
import {
  hasCriticalNeed,
  mostPressingNeed,
  needPressures,
  shelterDeadlineApproaching,
  NEED_CONCERN,
} from '../agents/needs.ts';
import type { GoalId, IdFactory, PlanId } from '../core/ids.ts';
import {
  bundleShortfall,
  expandRegion,
  horizontalDistance,
  region as makeRegion,
  RESOURCE_KINDS,
  type Position,
  type ResourceBundle,
  type ResourceKind,
  type WorldTime,
} from '../core/world.ts';
import { costOf, findBlueprint } from '../civilization/blueprints.ts';
import { asGoalChoice, type WorkRecommendation } from '../civilization/coordination.ts';
import { STRUCTURE_SEQUENCE } from '../civilization/settlement.ts';
import type { KnownResource } from '../memory/types.ts';
import { GOAL_KINDS, type Goal, type GoalParams } from './goal.ts';
import { makeStep, type Plan, type PlanStep } from './plan.ts';

/** Everything goal selection is allowed to see. Assembled deliberately small —
 *  this is what gets rendered into a prompt (requirement 29). */
export interface PlanningContext {
  readonly agent: Agent;
  readonly time: WorldTime;
  /** The agent's own beliefs — never another agent's (ADR-0007). */
  readonly knownResources: readonly KnownResource[];
  readonly knownShelter: Position | null;
  readonly settlementCenter: Position | null;
  /** What the agent is carrying. */
  readonly carrying: ResourceBundle;
  /** Recent memories retrieved for this decision. */
  readonly memories: readonly string[];
  /** What other agents are already working on, by goal kind. Used for the
   *  division-of-labour check — not for reading their private state. */
  readonly claimedWork: readonly string[];
  /** Structures the settlement already has. */
  readonly existingStructures: readonly string[];
  /**
   * The settlement work this agent should take on, already weighed against the
   * public claims of everyone else (requirement 18). Null when there is no
   * settlement yet, in which case the agent falls back to its own judgement.
   */
  readonly work: WorkRecommendation | null;
  readonly sheltered: boolean;
  readonly hostilesNearby: number;
}

/** What a goal-selection decision looks like. Flat and closed, so the model has
 *  the smallest possible chance of producing something unusable. */
export const GoalChoiceSchema = z.object({
  goal: z.enum(GOAL_KINDS),
  reason: z.string().min(1).max(300),
  priority: z.number().min(0).max(1),
  /** For gather_resource / find_food. */
  resource: z.enum(RESOURCE_KINDS).nullable(),
  quantity: z.number().int().min(1).max(512).nullable(),
  /** For build_structure — a blueprint name. */
  blueprint: z.string().nullable(),
});

export type GoalChoice = z.infer<typeof GoalChoiceSchema>;

// ── Rule-based goal selection ───────────────────────────────────────────────

/**
 * The deterministic answer, used as the fallback for every goal-selection call
 * and as the whole implementation when running without a model.
 *
 * Ordering reflects requirement 7: a critical need beats anything, an
 * approaching night without shelter beats ordinary work, and only then does the
 * agent do something useful with its day.
 */
export function ruleGoalChoice(context: PlanningContext): GoalChoice {
  const { agent, time } = context;

  const pressing = mostPressingNeed(agent.needs);

  if (pressing !== null && pressing.critical) {
    switch (pressing.kind) {
      case 'food':
        return {
          goal: 'find_food',
          reason: 'I am starving and must eat before anything else',
          priority: 1,
          resource: 'food',
          quantity: 6,
          blueprint: null,
        };
      case 'energy':
        return {
          goal: 'rest',
          reason: 'I am exhausted and cannot work',
          priority: 0.9,
          resource: null,
          quantity: null,
          blueprint: null,
        };
      case 'safety':
      case 'shelter':
        return shelterGoal(context, 'I am in danger with nowhere safe to be');
      case 'social':
        break;
    }
  }

  // Night is coming and there is nowhere to sleep — the deadline case.
  if (shelterDeadlineApproaching(time.phase, agent.needs)) {
    return shelterGoal(context, 'night is closing in and I have no shelter');
  }

  if (agent.needs.food <= NEED_CONCERN) {
    return {
      goal: 'find_food',
      reason: 'I am getting hungry',
      priority: 0.6,
      resource: 'food',
      quantity: 6,
      blueprint: null,
    };
  }

  // Survival is handled, so what the settlement needs is the question now — and
  // coordination has already scored the unclaimed roles against this agent's
  // skills. This is what stops five settlers each building their own shelter.
  //
  // Only a *project* role is authoritative. Coordination's `solo` fallbacks mean
  // "there is no settlement work on offer", which is the absence of an answer
  // rather than an answer — deferring to it there would leave an agent
  // exploring forever while the settlement had no shelter, because exploring is
  // always available and never fails.
  if (context.work !== null && context.work.kind === 'project') {
    return asGoalChoice(context.work);
  }

  const shelterExists = context.existingStructures.includes('shelter');
  if (!shelterExists && !context.claimedWork.includes('build_structure')) {
    return shelterGoal(context, 'the settlement still has no permanent shelter');
  }

  // Build toward the next structure the settlement lacks, gathering first when
  // the materials are short.
  const wanted = nextStructure(context.existingStructures);
  if (wanted !== null) {
    const shortfall = bundleShortfall(costOf(wanted), context.carrying);
    const missing = RESOURCE_KINDS.find((kind) => (shortfall[kind] ?? 0) > 0);
    if (missing !== undefined) {
      return {
        goal: 'gather_resource',
        reason: `the ${wanted} needs ${String(shortfall[missing])} more ${missing}`,
        priority: 0.55,
        resource: missing,
        quantity: Math.min(256, shortfall[missing] ?? 1),
        blueprint: null,
      };
    }
    if (!context.claimedWork.includes(`build:${wanted}`)) {
      return {
        goal: 'build_structure',
        reason: `we have the materials for a ${wanted}`,
        priority: 0.6,
        resource: null,
        quantity: null,
        blueprint: wanted,
      };
    }
  }

  // Nothing the settlement needs and nothing pressing: take coordination's solo
  // suggestion if it has one, since it weighed foraging and helping against
  // exploring, and fall back to exploring otherwise.
  if (context.work !== null) return asGoalChoice(context.work);

  // Exploring is how the settlement learns about its surroundings at all.
  // Curious agents prefer this more strongly.
  return {
    goal: 'explore_region',
    reason: 'there is more of this land to learn',
    priority: 0.25 + agent.personality.curiosity * 0.2,
    resource: null,
    quantity: null,
    blueprint: null,
  };
}

function shelterGoal(context: PlanningContext, reason: string): GoalChoice {
  const cost = costOf('small_shelter');
  const shortfall = bundleShortfall(cost, context.carrying);
  const missing = RESOURCE_KINDS.find((kind) => (shortfall[kind] ?? 0) > 0);

  // Wanting shelter and being able to build it are different things; if the
  // materials aren't there, the honest goal is to go and get them.
  if (missing !== undefined) {
    return {
      goal: 'gather_resource',
      reason: `${reason}, and I need ${String(shortfall[missing])} more ${missing} to build one`,
      priority: 0.85,
      resource: missing,
      quantity: Math.min(256, shortfall[missing] ?? 1),
      blueprint: null,
    };
  }

  return {
    goal: 'build_structure',
    reason,
    priority: 0.85,
    resource: null,
    quantity: null,
    blueprint: 'small_shelter',
  };
}

/**
 * The next thing a settlement of this maturity should have.
 *
 * The ordering lives in `civilization/settlement.ts` so projects and this
 * fallback cannot disagree about what the settlement needs next.
 */
function nextStructure(existing: readonly string[]): string | null {
  for (const step of STRUCTURE_SEQUENCE) {
    if (!existing.includes(step.type)) return step.blueprint;
  }
  return null;
}

// ── Turning a choice into a goal ────────────────────────────────────────────

/**
 * Normalise a choice into typed goal params, filling in anything the model left
 * out. A model that picks `gather_resource` without naming a resource gets a
 * sensible one rather than an invalid goal.
 */
export function goalFromChoice(
  choice: GoalChoice,
  context: PlanningContext,
  ids: IdFactory,
): Goal {
  const base = {
    id: ids.next('goal') as GoalId,
    agentId: context.agent.id,
    state: 'proposed' as const,
    priority: choice.priority,
    reason: choice.reason,
    parentGoalId: null,
    createdAtDay: context.time.day,
    createdAtTicks: context.time.totalTicks,
    resolvedAtTicks: null,
    outcome: null,
  };

  switch (choice.goal) {
    case 'gather_resource':
      return {
        ...base,
        kind: 'gather_resource',
        params: {
          resource: choice.resource ?? 'wood',
          quantity: choice.quantity ?? 16,
        },
      };
    case 'build_structure': {
      const blueprint =
        choice.blueprint !== null && findBlueprint(choice.blueprint) !== null
          ? choice.blueprint
          : 'small_shelter';
      return {
        ...base,
        kind: 'build_structure',
        params: {
          structureType: blueprint,
          blueprint,
          ...(context.settlementCenter !== null ? { site: context.settlementCenter } : {}),
        },
      };
    }
    case 'find_food':
      return { ...base, kind: 'find_food', params: { quantity: choice.quantity ?? 6 } };
    case 'seek_shelter':
      return { ...base, kind: 'seek_shelter', params: {} };
    case 'rest':
      return { ...base, kind: 'rest', params: { untilEnergy: 0.9 } };
    case 'explore_region': {
      const from = context.agent.position;
      // A ring outward from where the agent stands, so exploring genuinely
      // means going somewhere it hasn't been.
      const region = makeRegion(
        { x: from.x - 96, y: from.y - 32, z: from.z - 96 },
        { x: from.x + 96, y: from.y + 32, z: from.z + 96 },
      );
      return { ...base, kind: 'explore_region', params: { region } };
    }
    case 'deposit_resources':
      return { ...base, kind: 'deposit_resources', params: {} };
    case 'share_knowledge':
      return {
        ...base,
        kind: 'share_knowledge',
        params: { toAgentId: context.agent.id, subject: 'discoveries' },
      };
    case 'assist_agent':
      return {
        ...base,
        kind: 'assist_agent',
        params: {
          // Whoever actually asked for help, when coordination named someone.
          agentId: context.work?.targetAgentId ?? context.agent.id,
          with: context.work?.role === 'assist' ? 'what they asked for' : 'their current work',
        },
      };
  }
}

// ── Deterministic plan construction ─────────────────────────────────────────

/** How many plans a goal gets before it is not worth pursuing. */
export const MAX_PLAN_ATTEMPTS = 3;

/**
 * Build the plan for a goal. No model involved — the steps for a given goal kind
 * are not a judgement call.
 *
 * `attempt` is the number of plans this goal has already had. It matters: a
 * replan that reproduces the plan that just failed loops forever, so later
 * attempts prepend a leg that changes the agent's situation — going somewhere
 * else before looking again, which is what a person would do.
 */
export function buildPlan(
  goal: Goal,
  context: PlanningContext,
  ids: IdFactory,
  attempt = 0,
): Plan {
  const steps = stepsFor(goal, context, attempt);
  return {
    id: ids.next('plan') as PlanId,
    goalId: goal.id,
    agentId: goal.agentId,
    steps: steps.map((step, index) => ({ ...step, index })),
    currentStep: 0,
    state: 'active',
    createdAtTicks: context.time.totalTicks,
    revision: attempt,
  };
}

function stepsFor(goal: Goal, context: PlanningContext, attempt: number): PlanStep[] {
  switch (goal.kind) {
    case 'gather_resource': {
      const params = goal.params as GoalParams['gather_resource'];
      const known = nearestKnown(context, params.resource);
      const steps: PlanStep[] = [];

      // Looking in the same place again cannot find what wasn't there. Each
      // further attempt walks to fresh ground first, in a different direction.
      if (known === null && attempt > 0) {
        steps.push(
          makeStep(0, 'travel_to', {
            target: { kind: 'position', position: explorationTarget(context, attempt) },
          }),
          makeStep(0, 'survey_area', { region: surroundings(context), resolution: 4 }),
        );
      }

      // Only look if the agent doesn't already know where to go — an agent that
      // remembers a forest shouldn't re-survey for one.
      if (known === null) {
        steps.push(makeStep(0, 'locate_resource', { resource: params.resource, searchRadius: 80 }));
      }
      steps.push(makeStep(0, 'travel_to', { target: { kind: 'resource', resource: params.resource } }));
      steps.push(
        makeStep(0, 'harvest_resource', { resource: params.resource, quantity: params.quantity }),
        // Hand it over. Skipped when the agent holds no claim, so a settler
        // gathering for itself keeps what it found — but a gatherer working a
        // project stops hoarding, which is what funds shared construction.
        makeStep(0, 'deposit_resources', { resource: params.resource }),
      );
      return steps;
    }

    case 'build_structure': {
      const params = goal.params as GoalParams['build_structure'];
      const site = params.site ?? context.settlementCenter ?? context.agent.position;
      return [
        makeStep(0, 'select_site', {
          blueprint: params.blueprint,
          near: site,
          searchRadius: 40,
        }),
        makeStep(0, 'travel_to', { target: { kind: 'location', location: 'build_site' } }),
        makeStep(0, 'reserve_region', { region: siteRegion(site) }),
        makeStep(0, 'clear_site', { region: siteRegion(site) }),
        makeStep(0, 'place_blueprint', { blueprint: params.blueprint, origin: site }),
        makeStep(0, 'verify_structure', { blueprint: params.blueprint, origin: site }),
        makeStep(0, 'release_region', { region: siteRegion(site) }),
      ];
    }

    case 'find_food': {
      const params = goal.params as GoalParams['find_food'];
      return [
        ...(attempt > 0
          ? [
              makeStep(0, 'travel_to', {
                target: { kind: 'position', position: explorationTarget(context, attempt) },
              }),
              makeStep(0, 'survey_area', { region: surroundings(context), resolution: 4 }),
            ]
          : []),
        makeStep(0, 'locate_resource', { resource: 'food', searchRadius: 80 }),
        makeStep(0, 'travel_to', { target: { kind: 'resource', resource: 'food' } }),
        makeStep(0, 'harvest_resource', { resource: 'food', quantity: params.quantity }),
        makeStep(0, 'eat', { amount: Math.min(params.quantity, 4) }),
      ];
    }

    case 'seek_shelter': {
      const known = context.knownShelter;
      if (known !== null) {
        return [makeStep(0, 'travel_to', { target: { kind: 'position', position: known } })];
      }
      // No shelter known and none to walk to — this goal cannot be satisfied by
      // travelling, so it fails and the planner picks up a build goal instead.
      return [makeStep(0, 'travel_to', { target: { kind: 'location', location: 'shelter' } })];
    }

    case 'rest': {
      const params = goal.params as GoalParams['rest'];
      return [makeStep(0, 'rest', { untilEnergy: params.untilEnergy })];
    }

    case 'explore_region': {
      const params = goal.params as GoalParams['explore_region'];
      return [
        makeStep(0, 'survey_area', { region: params.region, resolution: 4 }),
        // Walk out to the far edge, so exploring changes where the agent is and
        // therefore what it can see next.
        makeStep(0, 'travel_to', {
          target: { kind: 'position', position: explorationTarget(context, attempt) },
        }),
        makeStep(0, 'survey_area', { region: params.region, resolution: 4 }),
      ];
    }

    case 'deposit_resources':
      return [
        makeStep(0, 'travel_to', { target: { kind: 'location', location: 'storage' } }),
        makeStep(0, 'deposit_resources', {}),
      ];

    case 'share_knowledge': {
      const params = goal.params as GoalParams['share_knowledge'];
      return [
        makeStep(0, 'send_message', {
          toAgentId: params.toAgentId,
          content: `I have news about ${params.subject}.`,
        }),
      ];
    }

    case 'assist_agent': {
      const params = goal.params as GoalParams['assist_agent'];
      return [
        makeStep(0, 'send_message', {
          toAgentId: params.agentId,
          content: `Can I help with ${params.with}?`,
        }),
      ];
    }
  }
}

/** The footprint a structure needs, with a margin so agents don't build flush
 *  against each other's walls. */
function siteRegion(origin: Position): { min: Position; max: Position } {
  return expandRegion(
    makeRegion(origin, { x: origin.x + 8, y: origin.y + 5, z: origin.z + 8 }),
    1,
  );
}

/**
 * Somewhere the agent has not already been.
 *
 * Rotated by attempt so successive tries genuinely fan out rather than walking
 * the same line repeatedly — an agent that found no wood to the north should
 * look east next, not north again.
 */
function explorationTarget(context: PlanningContext, attempt = 0): Position {
  const from = context.agent.position;
  const anchor = context.settlementCenter ?? from;
  const outward = Math.atan2(from.z - anchor.z, from.x - anchor.x);
  // A quarter turn per attempt, offset by the agent's own curiosity so five
  // settlers don't all sweep in lockstep.
  const bearing = outward + attempt * (Math.PI / 2) + context.agent.personality.curiosity;
  const reach = 56 + attempt * 24;
  return {
    x: Math.round(from.x + Math.cos(bearing) * reach),
    y: from.y,
    z: Math.round(from.z + Math.sin(bearing) * reach),
  };
}

/** The area around the agent, for a local survey. */
function surroundings(context: PlanningContext): { min: Position; max: Position } {
  const from = context.agent.position;
  return makeRegion(
    { x: from.x - 64, y: from.y - 32, z: from.z - 64 },
    { x: from.x + 64, y: from.y + 32, z: from.z + 64 },
  );
}

function nearestKnown(context: PlanningContext, resource: ResourceKind): KnownResource | null {
  let best: KnownResource | null = null;
  let bestDistance = Infinity;
  for (const known of context.knownResources) {
    if (known.resource !== resource || known.confidence <= 0) continue;
    const distance = horizontalDistance(context.agent.position, known.position);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = known;
    }
  }
  return best;
}

// ── Replanning ──────────────────────────────────────────────────────────────

export const RecoverySchema = z.object({
  /** `retry` keeps the plan, `replan` rebuilds it, `abandon` gives up the goal. */
  action: z.enum(['retry', 'replan', 'abandon']),
  reason: z.string().min(1).max(300),
});

export type Recovery = z.infer<typeof RecoverySchema>;

/**
 * The deterministic recovery rule, used as the fallback whenever a plan step
 * fails. Persistent agents try again; the kind of failure decides whether
 * trying again could possibly help.
 */
export function ruleRecovery(
  agent: Agent,
  failureKind: string,
  attempts: number,
  /** Plans this goal has already had. Past the ceiling, the goal is not
   *  achievable from where the agent is and should be given up. */
  planAttempts = 0,
): Recovery {
  if (planAttempts >= MAX_PLAN_ATTEMPTS) {
    return {
      action: 'abandon',
      reason: 'I have tried this several different ways and it is not working',
    };
  }

  // A missing resource or an unaffordable build won't fix itself by repetition —
  // the plan itself was based on a wrong belief.
  if (failureKind === 'RESOURCE_UNAVAILABLE' || failureKind === 'INSUFFICIENT_RESOURCES') {
    return { action: 'replan', reason: 'what I believed about the world was wrong' };
  }
  if (failureKind === 'REGION_RESERVED') {
    return { action: 'replan', reason: 'someone else is working there' };
  }
  if (failureKind === 'PATH_BLOCKED') {
    return { action: 'replan', reason: 'I cannot reach it from here' };
  }
  // Transport trouble is worth another go, if this agent is the persistent sort.
  const patience = 1 + Math.round(agent.personality.persistence * 2);
  if (attempts < patience) {
    return { action: 'retry', reason: 'that may have been bad luck' };
  }
  if (hasCriticalNeed(agent.needs)) {
    return { action: 'abandon', reason: 'I have more urgent problems than this' };
  }
  return { action: 'replan', reason: 'this approach is not working' };
}

/** A compact description of the situation, for a prompt. Kept short on purpose. */
export function describeSituation(context: PlanningContext): string {
  const { agent, time } = context;
  const lines: string[] = [
    `Day ${time.day}, ${time.phase}${time.weather === 'clear' ? '' : `, ${time.weather}`}.`,
    `You are ${agent.name}, ${agent.role}, at ${formatPos(agent.position)}.`,
    `Needs: ${needPressures(agent.needs)
      .map((pressure) => `${pressure.kind} ${Math.round(pressure.value * 100)}%`)
      .join(', ') || 'all comfortable'}.`,
    `Carrying: ${describeBundle(context.carrying)}.`,
  ];

  if (context.knownResources.length > 0) {
    const summary = context.knownResources
      .slice(0, 5)
      .map((known) => `${known.resource} at ${formatPos(known.position)}`)
      .join('; ');
    lines.push(`You know of: ${summary}.`);
  } else {
    lines.push('You know of no resource deposits yet.');
  }

  lines.push(
    context.existingStructures.length > 0
      ? `The settlement has: ${context.existingStructures.join(', ')}.`
      : 'The settlement has no structures yet.',
  );

  if (context.claimedWork.length > 0) {
    lines.push(`Others are already: ${context.claimedWork.join(', ')}.`);
  }
  if (context.hostilesNearby > 0) {
    lines.push(`${context.hostilesNearby} hostile creature(s) nearby.`);
  }
  if (context.memories.length > 0) {
    lines.push(`You remember: ${context.memories.slice(0, 5).join(' ')}`);
  }

  return lines.join('\n');
}

function formatPos(position: Position): string {
  return `(${Math.round(position.x)}, ${Math.round(position.y)}, ${Math.round(position.z)})`;
}

function describeBundle(bundle: ResourceBundle): string {
  const parts = RESOURCE_KINDS.filter((kind) => (bundle[kind] ?? 0) > 0).map(
    (kind) => `${String(bundle[kind])} ${kind}`,
  );
  return parts.length > 0 ? parts.join(', ') : 'nothing';
}
