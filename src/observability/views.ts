/**
 * View models: what the simulation currently is, as plain data.
 *
 * Requirement 23 rules out a system whose reasoning is invisible, and
 * requirement 24 asks that a dashboard be able to consume simulation state
 * easily. Those two pull in the same direction, and the thing that satisfies
 * both is a **separation between querying and formatting**. Everything here is a
 * pure function from a `Store` to a serialisable structure: no colours, no
 * padding, no `process.stdout`. The CLI renders these; a local web UI can send
 * the identical objects over the wire without a second query layer being written.
 *
 * Three rules the views hold to:
 *
 *  - **JSON only.** No `Map`, no `Set`, no `undefined`, no class instances.
 *    Grouped data is an array of records, absence is `null`. A test round-trips
 *    every view through `JSON.parse(JSON.stringify(…))` to keep this true.
 *  - **No omniscience.** An agent's view is built from that agent's own rows and
 *    from public facts (who exists, what stands, what the settlement owes). It
 *    never reaches into another agent's memories, knowledge or relationships
 *    (ADR-0007). The repositories make that structurally hard; the tests make it
 *    explicit.
 *  - **Nothing throws.** An empty world, a world with no settlement row, an
 *    unknown agent id — all produce empty or `null` views, never an exception.
 */

import {
  AGENT_STATUSES,
  clamp01,
  isAlive,
  NEEDS,
  type Agent,
  type AgentStatus,
  type NeedKind,
  type Personality,
  type Skills,
  type TickPhase,
} from '../agents/agent.ts';
import { NEED_CRITICAL, needPressures } from '../agents/needs.ts';
import type { Project, ProjectState, Settlement, Structure, StructureState } from '../civilization/types.ts';
import type { AgentId, GoalId } from '../core/ids.ts';
import type { ActionFailure } from '../core/result.ts';
import {
  bundleAdd,
  type DayPhase,
  type Position,
  type Region,
  type ResourceBundle,
  type Weather,
} from '../core/world.ts';
import type { EventType, WorldEvent } from '../events/types.ts';
import { describeGoal, type Goal, type GoalKind, type GoalParams, type GoalState } from '../goals/goal.ts';
import {
  describeStep,
  planProgress,
  type ActionKind,
  type Plan,
  type PlanState,
  type PlanStep,
  type StepStatus,
} from '../goals/plan.ts';
import {
  describeRelationship,
  type KnowledgeSource,
  type LocationKind,
  type MemoryEntry,
  type MemoryType,
  type Message,
  type Relationship,
} from '../memory/types.ts';
import { agentOwner, settlementOwner } from '../persistence/repositories/ledger.ts';
import type { SimulationStatus } from '../persistence/repositories/simulation.ts';
import type { Store } from '../persistence/store.ts';

// ── Shared shapes ───────────────────────────────────────────────────────────

export interface WorldTimeView {
  readonly day: number;
  readonly phase: DayPhase;
  readonly isDay: boolean;
  readonly weather: Weather;
  readonly totalTicks: number;
}

export interface CountView<K extends string = string> {
  readonly key: K;
  readonly count: number;
}

export interface ActorView {
  readonly id: string;
  /** Null when the actor is no longer in the agents table. */
  readonly name: string | null;
}

export interface FailureDetailView {
  readonly kind: string;
  readonly detail: string;
  readonly retryable: boolean | null;
  /** What the failure revealed about the world, when it revealed anything. */
  readonly observed?: unknown;
}

export interface GoalView {
  readonly id: string;
  readonly kind: GoalKind;
  /** A human-readable label. Derived from the params, so a dashboard in another
   *  language than TypeScript doesn't have to reimplement `describeGoal`. */
  readonly summary: string;
  readonly params: GoalParams[GoalKind];
  readonly state: GoalState;
  readonly priority: number;
  readonly reason: string;
  readonly parentGoalId: string | null;
  readonly createdAtDay: number;
  readonly createdAtTicks: number;
  readonly resolvedAtTicks: number | null;
  readonly outcome: string | null;
}

export interface PlanStepView {
  readonly index: number;
  readonly action: ActionKind;
  readonly summary: string;
  readonly params: PlanStep['params'];
  readonly status: StepStatus;
  readonly attempts: number;
  readonly failure: FailureDetailView | null;
  readonly note: string | null;
}

export interface PlanView {
  readonly id: string;
  readonly goalId: string;
  readonly state: PlanState;
  readonly revision: number;
  readonly currentStep: number;
  readonly progress: { readonly done: number; readonly total: number };
  readonly steps: readonly PlanStepView[];
}

export interface MemoryView {
  readonly id: string;
  readonly type: MemoryType;
  readonly content: string;
  readonly importance: number;
  readonly confidence: number;
  readonly source: KnowledgeSource;
  readonly relatedEntities: readonly string[];
  readonly tags: readonly string[];
  readonly createdAtDay: number;
  readonly createdAtTicks: number;
  readonly accessCount: number;
  readonly eventId: string | null;
  readonly consolidatedInto: string | null;
}

export interface EventView {
  readonly id: string;
  readonly seq: number;
  readonly type: EventType;
  readonly day: number;
  readonly worldTicks: number;
  readonly importance: number;
  readonly actor: ActorView | null;
  readonly payload: WorldEvent['payload'];
  readonly recordedAt: number;
}

// ── Civilization ────────────────────────────────────────────────────────────

export interface SettlementView {
  readonly id: string;
  readonly name: string;
  readonly objective: string;
  readonly foundingDay: number;
  readonly center: Position;
  readonly status: Settlement['status'];
}

export interface AgentSummaryView {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly status: AgentStatus;
  readonly phase: TickPhase;
  readonly health: number;
  readonly alive: boolean;
  readonly activity: string;
  readonly position: Position;
  readonly goal: GoalView | null;
  readonly planProgress: { readonly done: number; readonly total: number } | null;
}

export interface PopulationView {
  readonly total: number;
  readonly living: number;
  readonly dead: number;
  readonly byStatus: readonly CountView<AgentStatus>[];
  readonly agents: readonly AgentSummaryView[];
}

export interface StructureView {
  readonly id: string;
  readonly type: string;
  readonly blueprint: string;
  readonly state: StructureState;
  readonly purpose: string;
  readonly region: Region;
  readonly builders: readonly ActorView[];
  readonly createdAtDay: number;
  readonly verified: boolean;
}

export interface ProjectClaimView {
  readonly agent: ActorView;
  readonly role: string;
  readonly claimedAtTicks: number;
}

export interface ProjectView {
  readonly id: string;
  readonly kind: string;
  readonly blueprint: string | null;
  readonly state: ProjectState;
  readonly priority: number;
  readonly reason: string;
  readonly requirements: ResourceBundle;
  readonly site: Position | null;
  readonly createdAtDay: number;
  readonly completedAtTicks: number | null;
  readonly structureId: string | null;
  readonly claims: readonly ProjectClaimView[];
}

export interface HoldingView {
  readonly owner: ActorView;
  readonly holding: ResourceBundle;
}

export interface ResourcesView {
  /** Null when no settlement row exists yet — an older world, or one whose
   *  settlers have not founded anything. */
  readonly settlement: ResourceBundle | null;
  readonly agents: readonly HoldingView[];
  /** Everything the economy contains, whoever holds it. */
  readonly total: ResourceBundle;
}

export interface EventsView {
  readonly total: number;
  readonly latestSeq: number;
  readonly latestDay: number;
  readonly byType: readonly CountView<EventType>[];
}

/**
 * How much of the world the settlers have collectively seen.
 *
 * A civilization-level aggregate for a developer, deliberately reduced to counts
 * and a bounding box: it is assembled by asking each agent about its own rows,
 * and it is never fed back into anyone's reasoning. Nothing here can be used to
 * discover *what* another settler knows.
 */
export interface TerritoryView {
  readonly knownLocations: number;
  readonly knownResourceSites: number;
  readonly bounds: Region | null;
  /** Horizontal extent of the bounding box, in blocks. */
  readonly spanBlocks: number;
  readonly byAgent: readonly {
    readonly agent: ActorView;
    readonly locations: number;
    readonly resourceSites: number;
  }[];
}

export interface CivilizationView {
  /** False for a database with no simulation row — `worldloom run` never ran. */
  readonly initialised: boolean;
  readonly scenario: string | null;
  readonly status: SimulationStatus | null;
  readonly seed: number | null;
  readonly startedAt: number | null;
  readonly time: WorldTimeView;
  readonly settlement: SettlementView | null;
  readonly population: PopulationView;
  readonly structures: {
    readonly total: number;
    readonly standingTypes: readonly string[];
    readonly byState: readonly CountView<StructureState>[];
    readonly items: readonly StructureView[];
  };
  readonly projects: {
    readonly total: number;
    readonly open: number;
    readonly byState: readonly CountView<ProjectState>[];
    readonly items: readonly ProjectView[];
  };
  readonly resources: ResourcesView;
  readonly events: EventsView;
  readonly territory: TerritoryView;
}

// ── Agent ───────────────────────────────────────────────────────────────────

export interface NeedView {
  readonly kind: NeedKind;
  /** 0..1 satisfaction — 1 is met, 0 is critical. */
  readonly value: number;
  readonly urgency: number;
  readonly critical: boolean;
}

export interface RelationshipView {
  readonly other: ActorView;
  readonly trust: number;
  readonly affinity: number;
  readonly familiarity: number;
  readonly interactions: number;
  readonly summary: string;
  /** Why these numbers last moved, and the event that moved them. A
   *  relationship never changes without one (requirement 47). */
  readonly lastReason: string | null;
  readonly lastEventId: string | null;
  readonly lastEventType: EventType | null;
  readonly updatedAtTicks: number;
}

export interface KnownLocationView {
  readonly position: Position;
  readonly kind: LocationKind;
  readonly label: string;
  readonly confidence: number;
  readonly source: KnowledgeSource;
  readonly discoveredAtDay: number;
  readonly lastSeenAtTicks: number;
}

export interface KnownResourceView {
  readonly resource: string;
  readonly position: Position;
  readonly estimatedQuantity: number;
  readonly confidence: number;
  readonly source: KnowledgeSource;
  readonly discoveredAtDay: number;
  readonly lastSeenAtTicks: number;
}

export interface MessageView {
  readonly id: string;
  readonly from: ActorView;
  readonly to: ActorView;
  readonly content: string;
  readonly sentAtDay: number;
  readonly sentAtTicks: number;
  readonly read: boolean;
}

export interface AgentStateView {
  readonly identity: {
    readonly id: string;
    readonly name: string;
    readonly role: string;
    readonly personality: Personality;
    readonly skills: Skills;
    readonly spawnedAtDay: number;
  };
  readonly status: {
    readonly status: AgentStatus;
    readonly phase: TickPhase;
    readonly health: number;
    readonly alive: boolean;
    /** The agent's own note on what it is doing — its working summary. */
    readonly activity: string;
    readonly lastTickAt: number;
  };
  readonly position: Position;
  /** Every need, most urgent first. */
  readonly needs: readonly NeedView[];
  readonly inventory: ResourceBundle;
  readonly goal: GoalView | null;
  readonly plan: PlanView | null;
  /** Goals this agent has finished with, newest first — the record of what it
   *  gave up on as well as what it achieved. */
  readonly pastGoals: readonly GoalView[];
  readonly memories: readonly MemoryView[];
  readonly memoryCounts: {
    readonly total: number;
    readonly unconsolidatedEpisodic: number;
    readonly byType: readonly CountView<MemoryType>[];
  };
  readonly relationships: readonly RelationshipView[];
  readonly knownLocations: readonly KnownLocationView[];
  readonly knownResources: readonly KnownResourceView[];
  readonly messages: readonly MessageView[];
  readonly projectClaims: readonly {
    readonly projectId: string;
    readonly kind: string;
    readonly role: string;
    readonly claimedAtTicks: number;
  }[];
  readonly decisions: number;
}

/** How much history to include. The counts are caps, not requirements. */
export interface AgentViewOptions {
  readonly memories?: number;
  readonly messages?: number;
  readonly knownLocations?: number;
  readonly knownResources?: number;
  /** How many recent goals to consider; the resolved ones among them are
   *  returned, so a small number may yield fewer past goals than it suggests. */
  readonly pastGoals?: number;
}

// ── Live feed and failures ──────────────────────────────────────────────────

export interface LiveFeedView {
  readonly day: number;
  readonly latestSeq: number;
  /** Newest first — the order a "LIVE" panel scrolls in. */
  readonly entries: readonly EventView[];
}

export interface LiveFeedOptions {
  /** Only events after this sequence number, for incremental polling. */
  readonly sinceSeq?: number;
  readonly minImportance?: number;
  readonly types?: readonly EventType[];
}

export interface FailureEntryView {
  readonly eventId: string;
  readonly seq: number;
  readonly day: number;
  readonly worldTicks: number;
  readonly type: 'action_failed' | 'goal_failed';
  /** The failure kind for an action, the goal kind for a goal. */
  readonly kind: string;
  /** The action that failed, or the goal that did. */
  readonly subject: string;
  readonly detail: string;
  readonly agent: ActorView | null;
}

export interface FailureGroupView {
  readonly kind: string;
  readonly count: number;
  readonly agents: readonly { readonly agent: ActorView; readonly count: number }[];
  /** The most recent occurrence, so a reader has something concrete. */
  readonly latest: FailureEntryView;
}

export interface FailureView {
  /** Whole-run counts, independent of the window below. */
  readonly totals: {
    readonly actionFailed: number;
    readonly goalFailed: number;
    readonly goalAbandoned: number;
    readonly goalBlocked: number;
  };
  /** How many failure events the groups below were computed from. */
  readonly windowSize: number;
  readonly byKind: readonly FailureGroupView[];
  readonly recent: readonly FailureEntryView[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Name lookup for every agent, so views can label ids without a query each. */
export function agentNameIndex(store: Store): ReadonlyMap<string, string> {
  return new Map(store.agents.all().map((agent) => [agent.id as string, agent.name]));
}

function actor(names: ReadonlyMap<string, string>, id: string): ActorView {
  return { id, name: names.get(id) ?? null };
}

function counts<K extends string>(entries: Iterable<[K, number]>): CountView<K>[] {
  return [...entries]
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count]) => ({ key, count }));
}

export function failureDetailView(failure: ActionFailure): FailureDetailView {
  // Built conditionally: `exactOptionalPropertyTypes` forbids assigning an
  // explicit undefined, and a key holding undefined would not survive JSON.
  return {
    kind: failure.kind,
    detail: failure.detail,
    retryable: failure.retryable ?? null,
    ...(failure.observed !== undefined ? { observed: failure.observed } : {}),
  };
}

export function goalView(goal: Goal): GoalView {
  return {
    id: goal.id,
    kind: goal.kind,
    summary: describeGoal(goal),
    params: goal.params,
    state: goal.state,
    priority: goal.priority,
    reason: goal.reason,
    parentGoalId: goal.parentGoalId,
    createdAtDay: goal.createdAtDay,
    createdAtTicks: goal.createdAtTicks,
    resolvedAtTicks: goal.resolvedAtTicks,
    outcome: goal.outcome,
  };
}

export function planView(plan: Plan): PlanView {
  return {
    id: plan.id,
    goalId: plan.goalId,
    state: plan.state,
    revision: plan.revision,
    currentStep: plan.currentStep,
    progress: planProgress(plan),
    steps: plan.steps.map(
      (step): PlanStepView => ({
        index: step.index,
        action: step.action,
        summary: describeStep(step),
        params: step.params,
        status: step.status,
        attempts: step.attempts,
        failure: step.failure === null ? null : failureDetailView(step.failure),
        note: step.note,
      }),
    ),
  };
}

export function memoryView(memory: MemoryEntry): MemoryView {
  return {
    id: memory.id,
    type: memory.type,
    content: memory.content,
    importance: memory.importance,
    confidence: memory.confidence,
    source: memory.source,
    relatedEntities: memory.relatedEntities,
    tags: memory.tags,
    createdAtDay: memory.createdAtDay,
    createdAtTicks: memory.createdAtTicks,
    accessCount: memory.accessCount,
    eventId: memory.eventId,
    consolidatedInto: memory.consolidatedInto,
  };
}

export function eventView(event: WorldEvent, names: ReadonlyMap<string, string>): EventView {
  return {
    id: event.id,
    seq: event.seq,
    type: event.type,
    day: event.day,
    worldTicks: event.worldTicks,
    importance: event.importance,
    actor: event.actorId === null ? null : actor(names, event.actorId),
    payload: event.payload,
    recordedAt: event.recordedAt,
  };
}

/**
 * Find an agent by name or by id, case-insensitively.
 *
 * The CLI takes a name from a human and the views take an id; this is the one
 * place that gap gets bridged, rather than in every command.
 */
export function resolveAgent(store: Store, nameOrId: string): Agent | null {
  return store.agents.findByName(nameOrId) ?? store.agents.find(nameOrId as AgentId);
}

/** Current world time, falling back to the ledger for an uninitialised world. */
function timeView(store: Store): WorldTimeView {
  if (store.simulation.exists()) {
    const time = store.simulation.currentTime();
    return {
      day: time.day,
      phase: time.phase,
      isDay: time.isDay,
      weather: time.weather,
      totalTicks: time.totalTicks,
    };
  }
  return {
    day: store.events.latestDay(),
    phase: 'day',
    isDay: true,
    weather: 'clear',
    totalTicks: 0,
  };
}

function activeGoalOf(store: Store, agent: Agent): Goal | null {
  if (agent.currentGoalId === null) return null;
  return store.goals.find(agent.currentGoalId);
}

// ── Civilization view ───────────────────────────────────────────────────────

/**
 * The whole settlement at a glance: the top panel of any dashboard, and the
 * body of `worldloom status`.
 *
 * Structures and projects are returned in full rather than paged. A V0
 * settlement has a handful of each, and truncating them would make "what does
 * this settlement have?" answerable only approximately.
 */
export function civilizationView(store: Store): CivilizationView {
  const initialised = store.simulation.exists();
  const state = initialised ? store.simulation.get() : null;
  const names = agentNameIndex(store);
  const agents = store.agents.all();
  const settlement = store.settlements.primary() ?? store.settlements.all()[0] ?? null;

  const structures = store.structures.all();
  const projects = store.projects.all();

  return {
    initialised,
    scenario: state?.scenario ?? null,
    status: state?.status ?? null,
    seed: state?.seed ?? null,
    startedAt: state?.startedAt ?? null,
    time: timeView(store),
    settlement:
      settlement === null
        ? null
        : {
            id: settlement.id,
            name: settlement.name,
            objective: settlement.objective,
            foundingDay: settlement.foundingDay,
            center: settlement.center,
            status: settlement.status,
          },
    population: populationView(store, agents),
    structures: {
      total: structures.length,
      standingTypes: store.structures.standingTypes().sort(),
      byState: counts(tally(structures.map((structure) => structure.state))),
      items: structures.map((structure) => structureView(structure, names)),
    },
    projects: {
      total: projects.length,
      open: store.projects.open().length,
      byState: counts(tally(projects.map((project) => project.state))),
      items: projects.map((project) => projectView(store, project, names)),
    },
    resources: resourcesView(store, agents, settlement),
    events: {
      total: store.events.count(),
      latestSeq: store.events.latestSeq(),
      latestDay: store.events.latestDay(),
      byType: counts(store.events.countsByType()),
    },
    territory: territoryView(store, agents, names),
  };
}

function tally<K extends string>(values: readonly K[]): Map<K, number> {
  const out = new Map<K, number>();
  for (const value of values) out.set(value, (out.get(value) ?? 0) + 1);
  return out;
}

function populationView(store: Store, agents: readonly Agent[]): PopulationView {
  const byStatus = new Map<AgentStatus, number>(AGENT_STATUSES.map((status) => [status, 0]));
  for (const agent of agents) byStatus.set(agent.status, (byStatus.get(agent.status) ?? 0) + 1);

  return {
    total: agents.length,
    living: agents.filter((agent) => isAlive(agent)).length,
    dead: agents.filter((agent) => !isAlive(agent)).length,
    byStatus: counts(byStatus),
    agents: agents.map((agent): AgentSummaryView => {
      const goal = activeGoalOf(store, agent);
      const plan = goal === null ? null : store.plans.activeForGoal(goal.id);
      return {
        id: agent.id,
        name: agent.name,
        role: agent.role,
        status: agent.status,
        phase: agent.phase,
        health: agent.health,
        alive: isAlive(agent),
        activity: agent.activity,
        position: agent.position,
        goal: goal === null ? null : goalView(goal),
        planProgress: plan === null ? null : planProgress(plan),
      };
    }),
  };
}

function structureView(structure: Structure, names: ReadonlyMap<string, string>): StructureView {
  return {
    id: structure.id,
    type: structure.type,
    blueprint: structure.blueprint,
    state: structure.state,
    purpose: structure.purpose,
    region: structure.region,
    builders: structure.builders.map((id) => actor(names, id)),
    createdAtDay: structure.createdAtDay,
    verified: structure.verifiedAtTicks !== null,
  };
}

function projectView(store: Store, project: Project, names: ReadonlyMap<string, string>): ProjectView {
  return {
    id: project.id,
    kind: project.kind,
    blueprint: project.blueprint,
    state: project.state,
    priority: project.priority,
    reason: project.reason,
    requirements: project.requirements,
    site: project.site,
    createdAtDay: project.createdAtDay,
    completedAtTicks: project.completedAtTicks,
    structureId: project.structureId,
    claims: store.projects.claimsFor(project.id).map((claim) => ({
      agent: actor(names, claim.agentId),
      role: claim.role,
      claimedAtTicks: claim.claimedAtTicks,
    })),
  };
}

function resourcesView(
  store: Store,
  agents: readonly Agent[],
  settlement: Settlement | null,
): ResourcesView {
  const holdings = agents.map(
    (agent): HoldingView => ({
      owner: { id: agent.id, name: agent.name },
      holding: store.ledger.balance(agentOwner(agent.id)),
    }),
  );
  const settlementBundle =
    settlement === null ? null : store.ledger.balance(settlementOwner(settlement.id));

  // Sum from the ledger's own totals rather than from the two views above, so
  // stock held by an owner that is neither (a departed agent, a second
  // settlement) still shows up in the economy's total.
  let total: ResourceBundle = {};
  for (const bundle of store.ledger.totals().values()) total = bundleAdd(total, bundle);

  return { settlement: settlementBundle, agents: holdings, total };
}

function territoryView(
  store: Store,
  agents: readonly Agent[],
  names: ReadonlyMap<string, string>,
): TerritoryView {
  const locations = new Set<string>();
  const resourceSites = new Set<string>();
  let min: Position | null = null;
  let max: Position | null = null;

  const stretch = (position: Position): void => {
    min =
      min === null
        ? position
        : {
            x: Math.min(min.x, position.x),
            y: Math.min(min.y, position.y),
            z: Math.min(min.z, position.z),
          };
    max =
      max === null
        ? position
        : {
            x: Math.max(max.x, position.x),
            y: Math.max(max.y, position.y),
            z: Math.max(max.z, position.z),
          };
  };

  const byAgent = agents.map((agent) => {
    // One query per agent, each scoped to that agent — the aggregate is built
    // from consenting parts rather than from a cross-agent read (ADR-0007).
    const known = store.knowledge.knownLocations(agent.id);
    const deposits = store.knowledge.knownResources(agent.id);
    for (const place of known) {
      locations.add(`${place.kind}@${place.position.x},${place.position.y},${place.position.z}`);
      stretch(place.position);
    }
    for (const deposit of deposits) {
      resourceSites.add(
        `${deposit.resource}@${deposit.position.x},${deposit.position.y},${deposit.position.z}`,
      );
      stretch(deposit.position);
    }
    return {
      agent: actor(names, agent.id),
      locations: known.length,
      resourceSites: deposits.length,
    };
  });

  const bounds: Region | null = min === null || max === null ? null : { min, max };
  const spanBlocks =
    bounds === null
      ? 0
      : (bounds.max.x - bounds.min.x + 1) * (bounds.max.z - bounds.min.z + 1);

  return {
    knownLocations: locations.size,
    knownResourceSites: resourceSites.size,
    bounds,
    spanBlocks,
    byAgent,
  };
}

// ── Agent view ──────────────────────────────────────────────────────────────

/**
 * Everything about one agent: needs, goal, plan with per-step status, memories,
 * relationships, inventory, knowledge and correspondence — requirement 23's list.
 *
 * Strictly this agent's own state plus public facts. Returns null for an id that
 * is not an agent, rather than throwing, because the caller is usually holding a
 * name a human typed.
 */
export function agentView(
  store: Store,
  // A plain string is accepted as well as a branded id: these views are consumed
  // from JSON, where the brand does not survive, and a dashboard should not have
  // to re-brand an id it was just handed.
  agentId: AgentId | string,
  options: AgentViewOptions = {},
): AgentStateView | null {
  const agent = store.agents.find(agentId as AgentId);
  if (agent === null) return null;

  const names = agentNameIndex(store);
  const goal = activeGoalOf(store, agent);
  const plan = goal === null ? store.plans.activeForAgent(agent.id) : store.plans.activeForGoal(goal.id);

  const pressures = new Map(needPressures(agent.needs).map((pressure) => [pressure.kind, pressure]));
  const needs = NEEDS.map((kind): NeedView => {
    const value = clamp01(agent.needs[kind]);
    return {
      kind,
      value,
      urgency: pressures.get(kind)?.urgency ?? 0,
      critical: value <= NEED_CRITICAL,
    };
  }).sort((a, b) => b.urgency - a.urgency || a.value - b.value);

  const memories = store.memories.recent(agent.id, options.memories ?? 12);
  const byType = new Map<MemoryType, number>();
  for (const memory of memories) byType.set(memory.type, (byType.get(memory.type) ?? 0) + 1);

  const pastGoals = store.goals
    .allFor(agent.id, options.pastGoals ?? 10)
    .filter((candidate) => candidate.id !== goal?.id && candidate.resolvedAtTicks !== null);

  return {
    identity: {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      personality: agent.personality,
      skills: agent.skills,
      spawnedAtDay: agent.spawnedAtDay,
    },
    status: {
      status: agent.status,
      phase: agent.phase,
      health: agent.health,
      alive: isAlive(agent),
      activity: agent.activity,
      lastTickAt: agent.lastTickAt,
    },
    position: agent.position,
    needs,
    inventory: store.ledger.balance(agentOwner(agent.id)),
    goal: goal === null ? null : goalView(goal),
    plan: plan === null ? null : planView(plan),
    pastGoals: pastGoals.map(goalView),
    memories: memories.map(memoryView),
    memoryCounts: {
      total: store.memories.count(agent.id),
      unconsolidatedEpisodic: store.memories.unconsolidatedCount(agent.id),
      byType: counts(byType),
    },
    relationships: store.knowledge
      .relationshipsFor(agent.id)
      .map((relationship) => relationshipView(store, relationship, names)),
    knownLocations: store.knowledge
      .knownLocations(agent.id)
      .slice(0, options.knownLocations ?? 20)
      .map((place) => ({
        position: place.position,
        kind: place.kind,
        label: place.label,
        confidence: place.confidence,
        source: place.source,
        discoveredAtDay: place.discoveredAtDay,
        lastSeenAtTicks: place.lastSeenAtTicks,
      })),
    knownResources: store.knowledge
      .knownResources(agent.id)
      .slice(0, options.knownResources ?? 20)
      .map((deposit) => ({
        resource: deposit.resource,
        position: deposit.position,
        estimatedQuantity: deposit.estimatedQuantity,
        confidence: deposit.confidence,
        source: deposit.source,
        discoveredAtDay: deposit.discoveredAtDay,
        lastSeenAtTicks: deposit.lastSeenAtTicks,
      })),
    messages: store.messages
      .historyFor(agent.id, options.messages ?? 10)
      .map((message) => messageView(message, names)),
    projectClaims: store.projects.claimsBy(agent.id).map((claim) => ({
      projectId: claim.projectId,
      kind: store.projects.find(claim.projectId)?.kind ?? 'unknown',
      role: claim.role,
      claimedAtTicks: claim.claimedAtTicks,
    })),
    decisions: store.decisions.countForAgent(agent.id),
  };
}

function relationshipView(
  store: Store,
  relationship: Relationship,
  names: ReadonlyMap<string, string>,
): RelationshipView {
  const event = relationship.lastEventId === null ? null : store.events.find(relationship.lastEventId);
  return {
    other: actor(names, relationship.otherAgentId),
    trust: relationship.trust,
    affinity: relationship.affinity,
    familiarity: relationship.familiarity,
    interactions: relationship.interactions,
    summary: describeRelationship(relationship),
    lastReason: relationship.lastReason,
    lastEventId: relationship.lastEventId,
    lastEventType: event?.type ?? null,
    updatedAtTicks: relationship.updatedAtTicks,
  };
}

function messageView(message: Message, names: ReadonlyMap<string, string>): MessageView {
  return {
    id: message.id,
    from: actor(names, message.fromAgentId),
    to: actor(names, message.toAgentId),
    content: message.content,
    sentAtDay: message.sentAtDay,
    sentAtTicks: message.sentAtTicks,
    read: message.readAtTicks !== null,
  };
}

// ── Live feed ───────────────────────────────────────────────────────────────

/**
 * The recent-events feed, newest first.
 *
 * `sinceSeq` makes this pollable: a dashboard keeps the last `latestSeq` it saw
 * and asks only for what followed, so a live panel costs one small query per
 * refresh rather than a full re-read of the ledger.
 */
export function liveFeedView(store: Store, limit = 20, options: LiveFeedOptions = {}): LiveFeedView {
  const names = agentNameIndex(store);
  const query = {
    limit: Math.max(1, Math.floor(limit)),
    ...(options.sinceSeq !== undefined ? { sinceSeq: options.sinceSeq } : {}),
    ...(options.minImportance !== undefined ? { minImportance: options.minImportance } : {}),
    ...(options.types !== undefined ? { types: options.types } : {}),
  };

  // Polling and browsing want opposite ends of the ledger. A poller must not
  // skip anything, so `sinceSeq` takes the *oldest* unseen events and only
  // reverses them for display; everything else takes the newest.
  const events =
    options.sinceSeq === undefined
      ? store.events.query({ ...query, newestFirst: true })
      : store.events.query(query).reverse();

  return {
    day: timeView(store).day,
    latestSeq: store.events.latestSeq(),
    entries: events.map((event) => eventView(event, names)),
  };
}

// ── Failures ────────────────────────────────────────────────────────────────

/**
 * What is going wrong, grouped by kind.
 *
 * The grouping is the point. A run that produces two hundred failures is not
 * two hundred problems — it is usually two, one of them repeated. Whole-run
 * totals come from the ledger's own counters; the groups are computed from the
 * most recent `limit` failures, so a long run's report stays about the present.
 */
export function failureView(store: Store, limit = 50): FailureView {
  const names = agentNameIndex(store);
  const byType = store.events.countsByType();
  const events = store.events.recentOfTypes(['action_failed', 'goal_failed'], limit);
  const entries = events.map((event) => failureEntryView(event, names));

  const groups = new Map<string, FailureEntryView[]>();
  for (const entry of entries) {
    const bucket = groups.get(entry.kind);
    if (bucket === undefined) groups.set(entry.kind, [entry]);
    else bucket.push(entry);
  }

  const byKind: FailureGroupView[] = [...groups.entries()]
    .map(([kind, bucket]) => {
      const perAgent = new Map<string, number>();
      for (const entry of bucket) {
        if (entry.agent === null) continue;
        perAgent.set(entry.agent.id, (perAgent.get(entry.agent.id) ?? 0) + 1);
      }
      // `recentOfTypes` returns newest first, so the head of the bucket is the
      // latest occurrence.
      const latest = bucket[0]!;
      return {
        kind,
        count: bucket.length,
        agents: [...perAgent.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([id, count]) => ({ agent: actor(names, id), count })),
        latest,
      };
    })
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));

  return {
    totals: {
      actionFailed: byType.get('action_failed') ?? 0,
      goalFailed: byType.get('goal_failed') ?? 0,
      goalAbandoned: byType.get('goal_abandoned') ?? 0,
      goalBlocked: byType.get('goal_blocked') ?? 0,
    },
    windowSize: entries.length,
    byKind,
    recent: entries,
  };
}

function failureEntryView(event: WorldEvent, names: ReadonlyMap<string, string>): FailureEntryView {
  const payload = event.payload as {
    action?: string;
    failureKind?: string;
    detail?: string;
    kind?: string;
    reason?: string;
    goalId?: GoalId;
  };
  const isAction = event.type === 'action_failed';

  return {
    eventId: event.id,
    seq: event.seq,
    day: event.day,
    worldTicks: event.worldTicks,
    type: isAction ? 'action_failed' : 'goal_failed',
    kind: (isAction ? payload.failureKind : payload.kind) ?? 'UNKNOWN',
    subject: (isAction ? payload.action : payload.goalId) ?? '',
    detail: (isAction ? payload.detail : payload.reason) ?? '',
    agent: event.actorId === null ? null : actor(names, event.actorId),
  };
}
