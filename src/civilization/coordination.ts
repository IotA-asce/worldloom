/**
 * Division of labour without a scheduler (requirement 18).
 *
 * The failure this exists to fix: five settlers each decide the settlement needs
 * shelter, and five shelters get built. Nobody was wrong — they were all reasoning
 * correctly from the same facts, in ignorance of each other.
 *
 * The fix is not a foreman handing out jobs. It is that **what everyone is doing
 * is public and countable**, so an agent reasoning alone reaches a different
 * conclusion than it would have. Four mechanisms, in the order they matter:
 *
 *  1. **Claims are read before work is chosen.** `building` on a project has a
 *     capacity of one; the second agent to look sees it taken and looks elsewhere.
 *     Nothing coordinates them — the second agent simply has better information.
 *  2. **Roles are scored by the agent's own skills and personality.** The Builder
 *     values building highest, the Miner values stone; they diverge without being
 *     told to. Work nobody has taken on carries a bonus, so gaps get filled
 *     before crowds form.
 *  3. **An agent whose skills fit nothing open does something useful alone** —
 *     exploring or foraging, weighted by what it is good at.
 *  4. **Shortfalls and requests for help pull.** A shortfall in the shared store
 *     appears as gathering roles; a `help_requested` event scores by
 *     cooperativeness, so the obliging respond and the heads-down carry on.
 *
 * What this reads is public: project rows, live claims, standing structures, the
 * settlement's shared store, and announced requests for help. It never reads
 * another agent's memories, knowledge, goals or plans (ADR-0007). The deciding
 * agent's own skills and needs are its own to read.
 *
 * No model is consulted. Scoring a bounded list of public roles is exactly the
 * kind of repetitive arithmetic architecture.md §3 lists as deterministic, and
 * making it deterministic is what lets the criterion test assert a distribution
 * rather than hope for one. If a model is ever gated in front of this, ADR-0006
 * requires `chooseWork` as its fallback — which is why it is a pure function of
 * a context object.
 */

import { clamp01, type Agent } from '../agents/agent.ts';
import type { AgentId, ProjectId } from '../core/ids.ts';
import { ok, type Result } from '../core/result.ts';
import {
  bundleGet,
  type ResourceBundle,
  type ResourceKind,
  type WorldTime,
} from '../core/world.ts';
import type { GoalKind } from '../goals/goal.ts';
import { agentOwner } from '../persistence/repositories/ledger.ts';
import type { Store } from '../persistence/store.ts';
import {
  claimRole,
  isRoleAvailableTo,
  openRoles,
  releaseClaimsBy,
  type RoleSlot,
} from './projects.ts';
import {
  FOOD_PER_SETTLER,
  population,
  primarySettlement,
  settlementStock,
  standingStructureTypes,
} from './settlement.ts';
import type { ProjectClaim } from './types.ts';

// ── Weights ─────────────────────────────────────────────────────────────────
//
// Named because they are the tuning surface: if agents converge on identical
// behaviour (risk R5), these are the numbers to move, and a test should fail
// when they move too far.

/** Floor on how attractive work is to someone with no aptitude for it. */
const FIT_FLOOR = 0.25;
/** How much of a role's value comes from being good at it. */
const FIT_FROM_SKILL = 0.75;
/** Bonus for a project nobody has taken up. Unattended work is the visible gap. */
const UNATTENDED_BONUS = 0.12;
/** How much company on a project matters, either way. */
const COMPANY_WEIGHT = 0.15;
/** Sticking with what you announced, so agents don't thrash between roles. */
const CONTINUITY_BASE = 0.1;
const CONTINUITY_FROM_PERSISTENCE = 0.2;
/** Already carrying what a role wants. Small: it saves a trip, not a day. */
const IN_HAND_WEIGHT = 0.08;
/**
 * Solo work: worth doing, and worth nobody claiming. The floors are what stop a
 * settler with no useful skill from taking a role it would be bad at, and the
 * skill terms are what make the Explorer explore rather than queue for timber.
 */
const EXPLORE_BASE = 0.35;
const EXPLORE_FROM_SKILL = 0.5;
const EXPLORE_FROM_CURIOSITY = 0.15;
/** Curiosity yields a little while the settlement has no roof at all. */
const ROOFLESS_DAMPING = 0.9;
const FORAGE_BASE = 0.3;
const FORAGE_FROM_APTITUDE = 0.7;
/** Answering an appeal for help: mostly a question of temperament. */
const ASSIST_BASE = 0.35;
const ASSIST_FROM_COOPERATIVENESS = 0.55;
/** How long a request for help stays interesting. A quarter of a day. */
export const HELP_WINDOW_TICKS = 6_000;
/**
 * How much the settlement's empty food store counts as pressure. Damped, because
 * settlers carry food the shared store cannot see, so an empty store overstates
 * the crisis.
 */
const COMMUNAL_FOOD_WEIGHT = 0.6;

// ── Context ─────────────────────────────────────────────────────────────────

/** A public appeal for help. Who asked, for what, and when. */
export interface HelpRequest {
  readonly agentId: AgentId;
  readonly need: string;
  readonly detail: string;
  readonly atTicks: number;
}

/**
 * Everything work selection is allowed to see.
 *
 * Deliberately assembled from public tables plus the deciding agent's own state.
 * There is no field here through which another agent's beliefs could arrive.
 */
export interface CoordinationContext {
  readonly agent: Agent;
  readonly time: WorldTime;
  /** Every role on every open project, with who holds it. */
  readonly roles: readonly RoleSlot[];
  /** Live requests for help, excluding the agent's own. */
  readonly helpRequests: readonly HelpRequest[];
  readonly standingStructures: readonly string[];
  /** What the deciding agent is carrying — its own ledger, nobody else's. */
  readonly carrying: ResourceBundle;
  /** 0..1 — the agent's own hunger or the settlement's bare store, whichever is
   *  worse. Drives foraging when no project wants food. */
  readonly foodPressure: number;
}

/** A role considered and what it scored. Kept on the recommendation so a
 *  surprising choice can be explained without re-deriving it. */
export interface ScoredRole {
  readonly role: string;
  readonly projectId: ProjectId | null;
  readonly score: number;
}

export interface WorkRecommendation {
  /** `project` means claim a role; `solo` means useful work nobody need own. */
  readonly kind: 'project' | 'solo';
  readonly projectId: ProjectId | null;
  readonly role: string;
  readonly goal: GoalKind;
  readonly resource: ResourceKind | null;
  readonly quantity: number | null;
  readonly blueprint: string | null;
  /** For `assist` — who asked. */
  readonly targetAgentId: AgentId | null;
  /** How much the settlement cares that this gets done, 0..1. Becomes the goal's
   *  priority, so it is comparable with the need-driven goals in the planner. */
  readonly priority: number;
  /** How much *this* agent wanted it relative to everything else on offer. The
   *  ranking that produced the choice, kept for explaining it. */
  readonly score: number;
  /** First person, and specific: this becomes the goal's `reason`. */
  readonly reason: string;
  readonly considered: readonly ScoredRole[];
}

// ── Choosing ────────────────────────────────────────────────────────────────

/**
 * What this agent should take on next.
 *
 * A pure function of the context, so the same five settlers looking at the same
 * board always divide the same way — which is what makes division of labour
 * testable rather than anecdotal.
 */
export function chooseWork(context: CoordinationContext): WorkRecommendation {
  const candidates: WorkRecommendation[] = [];

  for (const slot of context.roles) {
    if (!isRoleAvailableTo(slot, context.agent.id)) continue;
    candidates.push(projectRecommendation(context, slot));
  }
  // Exploring is always available, so there is always something to choose.
  candidates.push(...soloRecommendations(context));

  // Deterministic ordering: score, then role name, then project id. Without the
  // last two, insertion order would settle ties and the distribution would drift
  // with unrelated changes.
  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      a.role.localeCompare(b.role) ||
      (a.projectId ?? '').localeCompare(b.projectId ?? ''),
  );

  const chosen = candidates[0] ?? exploreRecommendation(0);
  return {
    ...chosen,
    considered: candidates
      .slice(0, 6)
      .map((candidate) => ({
        role: candidate.role,
        projectId: candidate.projectId,
        score: candidate.score,
      })),
  };
}

function projectRecommendation(context: CoordinationContext, slot: RoleSlot): WorkRecommendation {
  const { agent } = context;
  const fit = FIT_FLOOR + FIT_FROM_SKILL * clamp01(agent.skills[slot.skill]);
  const others = slot.holders.filter((holder) => holder !== agent.id).length;

  // Company cuts both ways: the cooperative are drawn to work already underway,
  // the independent to work they can own.
  const projectHolders = context.roles
    .filter((candidate) => candidate.projectId === slot.projectId)
    .flatMap((candidate) => candidate.holders);
  const joined = projectHolders.some((holder) => holder !== agent.id);
  const company = joined
    ? COMPANY_WEIGHT * (agent.personality.cooperativeness - 0.5)
    : COMPANY_WEIGHT * (agent.personality.independence - 0.5) * 0.5;

  const unattended = projectHolders.length === 0 ? UNATTENDED_BONUS * slot.priority : 0;
  const continuity = slot.holders.includes(agent.id)
    ? CONTINUITY_BASE + CONTINUITY_FROM_PERSISTENCE * agent.personality.persistence
    : 0;

  // Already holding some of what the role wants means it can be delivered now
  // rather than fetched, which is worth a little.
  const inHand =
    slot.resource === null || slot.quantity === null || slot.quantity <= 0
      ? 0
      : IN_HAND_WEIGHT * Math.min(1, bundleGet(context.carrying, slot.resource) / slot.quantity);

  const score = slot.priority * fit * (1 + company) + unattended + continuity + inHand;

  return {
    kind: 'project',
    projectId: slot.projectId,
    role: slot.role,
    goal: slot.goal,
    resource: slot.resource,
    quantity: slot.quantity,
    blueprint: slot.blueprint,
    targetAgentId: null,
    priority: slot.priority,
    score,
    reason: reasonFor(slot, others),
    considered: [],
  };
}

function reasonFor(slot: RoleSlot, others: number): string {
  const shared = others > 0 ? ', and others are already on it' : '';
  if (slot.role === 'building') return `${slot.detail}${shared}`;
  if (slot.role === 'siting') return `${slot.detail}, and I know this ground`;
  return `${slot.detail}, and fetching is what I am good for${shared}`;
}

/** Useful work that needs no claim, for an agent nothing open suits. */
function soloRecommendations(context: CoordinationContext): WorkRecommendation[] {
  const out: WorkRecommendation[] = [exploreRecommendation(exploreScore(context))];

  const forage = forageScore(context);
  if (forage > 0) {
    out.push({
      kind: 'solo',
      projectId: null,
      role: 'forage',
      goal: 'find_food',
      resource: 'food',
      quantity: 6,
      blueprint: null,
      targetAgentId: null,
      priority: 0.6,
      score: forage,
      reason: 'someone has to find food, and I know what can be eaten',
      considered: [],
    });
  }

  const request = mostPressingRequest(context);
  if (request !== null) {
    out.push({
      kind: 'solo',
      projectId: null,
      role: 'assist',
      goal: 'assist_agent',
      resource: null,
      quantity: null,
      blueprint: null,
      targetAgentId: request.request.agentId,
      priority: 0.5,
      score: request.score,
      reason: `someone asked for help with ${request.request.need}`,
      considered: [],
    });
  }

  return out;
}

function exploreRecommendation(score: number): WorkRecommendation {
  return {
    kind: 'solo',
    projectId: null,
    role: 'explore',
    goal: 'explore_region',
    resource: null,
    quantity: null,
    blueprint: null,
    targetAgentId: null,
    priority: 0.35,
    score,
    reason: 'nothing here needs me more than the land needs learning',
    considered: [],
  };
}

/**
 * Exploring is worth most to someone good at it and curious. Damped while the
 * settlement has no shelter at all — survival before curiosity, but only just,
 * because a settlement that never scouts never finds the timber either.
 */
function exploreScore(context: CoordinationContext): number {
  const { agent } = context;
  const raw =
    EXPLORE_BASE +
    EXPLORE_FROM_SKILL * clamp01(agent.skills.exploration) +
    EXPLORE_FROM_CURIOSITY * clamp01(agent.personality.curiosity);
  const roofless = context.standingStructures.includes('shelter') ? 1 : ROOFLESS_DAMPING;
  return raw * roofless;
}

function forageScore(context: CoordinationContext): number {
  const { agent } = context;
  const aptitude = Math.max(clamp01(agent.skills.farming), clamp01(agent.skills.gathering));
  return context.foodPressure * (FORAGE_BASE + FORAGE_FROM_APTITUDE * aptitude);
}

function mostPressingRequest(
  context: CoordinationContext,
): { readonly request: HelpRequest; readonly score: number } | null {
  let best: { request: HelpRequest; score: number } | null = null;
  for (const request of context.helpRequests) {
    if (request.agentId === context.agent.id) continue;
    const age = context.time.totalTicks - request.atTicks;
    if (age < 0 || age > HELP_WINDOW_TICKS) continue;
    const recency = 1 - age / HELP_WINDOW_TICKS;
    const score =
      (ASSIST_BASE + ASSIST_FROM_COOPERATIVENESS * clamp01(context.agent.personality.cooperativeness)) *
      recency;
    if (best === null || score > best.score) best = { request, score };
  }
  return best;
}

// ── Turning a recommendation into a goal choice ──────────────────────────────

/**
 * The shape `ruleGoalChoice` produces, so a recommendation can be returned from
 * the planner directly. Structurally identical to `GoalChoice` on purpose —
 * declared here rather than imported to keep civilization free of a dependency
 * on the planner that would make the two mutually recursive.
 */
export interface GoalChoiceLike {
  readonly goal: GoalKind;
  readonly reason: string;
  readonly priority: number;
  readonly resource: ResourceKind | null;
  readonly quantity: number | null;
  readonly blueprint: string | null;
}

export function asGoalChoice(recommendation: WorkRecommendation): GoalChoiceLike {
  return {
    goal: recommendation.goal,
    reason: recommendation.reason,
    // The settlement's stake, not the agent's enthusiasm: goal priorities are
    // compared against need-driven goals, and "I am good at this" is not urgency.
    priority: clamp01(recommendation.priority),
    resource: recommendation.resource,
    quantity: recommendation.quantity,
    blueprint: recommendation.blueprint,
  };
}

// ── Reading the public board, and writing to it ──────────────────────────────

/**
 * Assemble the context from public state.
 *
 * The only per-agent reads are the deciding agent's own ledger balance and its
 * own needs. Everything else is settlement-level fact.
 */
export function coordinationContext(store: Store, agent: Agent, time: WorldTime): CoordinationContext {
  const settlement = primarySettlement(store);
  const stock = settlement === null ? {} : settlementStock(store, settlement.id);

  return {
    agent,
    time,
    roles: openRoles(store),
    helpRequests: recentHelpRequests(store, time),
    standingStructures: standingStructureTypes(store),
    carrying: store.ledger.balance(agentOwner(agent.id)),
    foodPressure: foodPressure(store, agent, stock),
  };
}

/** Requests still inside the window, newest first. */
export function recentHelpRequests(store: Store, time: WorldTime): HelpRequest[] {
  const out: HelpRequest[] = [];
  for (const event of store.events.query({ types: ['help_requested'] })) {
    if (time.totalTicks - event.worldTicks > HELP_WINDOW_TICKS) continue;
    const payload = event.payload as { agentId: AgentId; need: string; detail: string };
    out.push({
      agentId: payload.agentId,
      need: payload.need,
      detail: payload.detail,
      atTicks: event.worldTicks,
    });
  }
  return out.reverse();
}

function foodPressure(store: Store, agent: Agent, stock: ResourceBundle): number {
  const hunger = 1 - clamp01(agent.needs.food);
  const target = Math.max(1, population(store) * FOOD_PER_SETTLER);
  const communal = clamp01((target - bundleGet(stock, 'food')) / target) * COMMUNAL_FOOD_WEIGHT;
  return clamp01(Math.max(hunger, communal));
}

export interface ApplyOptions {
  readonly agent: Agent;
  readonly recommendation: WorkRecommendation;
  readonly time: WorldTime;
}

/**
 * Make the recommendation public.
 *
 * A project role is announced as a claim — which is what the *next* agent to
 * choose will read. Solo work releases whatever this agent had taken on, because
 * a claim nobody is honouring is worse than no claim: it makes the board lie.
 */
export function applyRecommendation(
  store: Store,
  options: ApplyOptions,
): Result<ProjectClaim | null> {
  const { recommendation, time } = options;

  if (recommendation.kind === 'solo' || recommendation.projectId === null) {
    releaseClaimsBy(store, options.agent.id, time.totalTicks);
    return ok(null);
  }

  const claimed = claimRole(store, {
    projectId: recommendation.projectId,
    agentId: options.agent.id,
    role: recommendation.role,
    time: { day: time.day, worldTicks: time.totalTicks },
  });
  // Take the new role before giving up the old one. Releasing first would leave an
  // agent with nothing at all whenever the new role turned out to be taken.
  if (!claimed.ok) return claimed;

  // One settler, one job: anything else it had announced is dropped, so the board
  // never shows a settler in two places.
  for (const claim of store.projects.claimsBy(options.agent.id)) {
    if (claim.projectId !== recommendation.projectId || claim.role !== recommendation.role) {
      store.projects.release(claim.projectId, options.agent.id, time.totalTicks);
    }
  }

  return ok(claimed.value);
}

export interface HelpOptions {
  readonly agent: Agent;
  readonly need: string;
  readonly detail: string;
  readonly time: WorldTime;
}

/**
 * Ask the settlement for help.
 *
 * Public, so it can pull without addressing anyone: whoever is most obliging and
 * least busy answers. That is cheaper and more lifelike than choosing a target.
 */
export function requestHelp(store: Store, options: HelpOptions): void {
  store.events.append(
    {
      type: 'help_requested',
      actorId: options.agent.id,
      payload: { agentId: options.agent.id, need: options.need, detail: options.detail },
    },
    { day: options.time.day, worldTicks: options.time.totalTicks },
  );
}

/** A one-line summary of who is doing what, for the CLI and for tests. */
export function describeDivisionOfLabour(store: Store): string[] {
  const lines: string[] = [];
  for (const slot of openRoles(store)) {
    if (slot.holders.length === 0) continue;
    lines.push(`${slot.role}: ${slot.holders.join(', ')}`);
  }
  return lines.sort();
}

export type { RoleSlot };
