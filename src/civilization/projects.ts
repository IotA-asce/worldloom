/**
 * Projects: work the settlement wants done, which outlives whoever is doing it.
 *
 * This is the fix for the failure M1 left behind — five settlers each building
 * their own shelter. A project is a single public object saying "one shelter,
 * here, priced at 60 timber and 25 masonry", and the roles on it are countable.
 * Five agents looking at one shelter project can see that the building is taken
 * and the timber is not, which is all coordination needs to be possible
 * (coordination.ts does the choosing; this module only says what is on offer).
 *
 * Three design points worth stating, because each rules out an easier design
 * that would have been dishonest:
 *
 *  - **Requirements are priced from the blueprint, never declared.** `costOf`
 *    sums the blocks, so a bigger shelter genuinely costs more (ADR-0004).
 *  - **A project holds no resources.** Contributions move into the settlement's
 *    ledger, and progress is measured against that shared store. A project with
 *    its own private pile would be a second ledger to keep honest.
 *  - **The kind string carries what the project produces** (`build:small_shelter`,
 *    `stockpile:food`), so `project_created` is enough to rebuild the row. A
 *    projection that cannot be rebuilt from the ledger is a source of truth
 *    pretending not to be.
 */

import type { Skill } from '../agents/agent.ts';
import type { AgentId, ProjectId, SettlementId, StructureId } from '../core/ids.ts';
import { fail, ok, type Result } from '../core/result.ts';
import {
  bundleGet,
  bundleShortfall,
  formatBundle,
  isResourceKind,
  RESOURCE_KINDS,
  type ResourceBundle,
  type ResourceKind,
} from '../core/world.ts';
import type { GoalKind } from '../goals/goal.ts';
import { agentOwner, settlementOwner } from '../persistence/repositories/ledger.ts';
import type { Store } from '../persistence/store.ts';
import { costOf, findBlueprint, structureTypeOf } from './blueprints.ts';
import {
  FOOD_PER_SETTLER,
  nextNeededStructure,
  population,
  reconcileSettlementState,
  settlementCenter,
  settlementStock,
  STRUCTURE_SEQUENCE,
  type ReconcileOptions,
  type ReconcileReport,
  type TimeContext,
} from './settlement.ts';
import { isActive, type Project, type ProjectClaim, type Structure } from './types.ts';

// ── The kind vocabulary ─────────────────────────────────────────────────────

export function buildKind(blueprint: string): string {
  return `build:${blueprint}`;
}

export function stockpileKind(resource: ResourceKind): string {
  return `stockpile:${resource}`;
}

/** The blueprint a build project produces, or null when it isn't a build. */
export function blueprintOfKind(kind: string): string | null {
  if (!kind.startsWith('build:')) return null;
  const name = kind.slice('build:'.length);
  return findBlueprint(name) === null ? null : name;
}

/** The resource a stockpile project accumulates, or null. */
export function resourceOfKind(kind: string): ResourceKind | null {
  if (!kind.startsWith('stockpile:')) return null;
  const name = kind.slice('stockpile:'.length);
  return isResourceKind(name) ? name : null;
}

/** How much the settlement cares, derived from the kind so a rebuilt row matches. */
export function priorityOfKind(kind: string): number {
  const blueprint = blueprintOfKind(kind);
  if (blueprint !== null) {
    const type = structureTypeOf(blueprint);
    return STRUCTURE_SEQUENCE.find((wanted) => wanted.type === type)?.priority ?? 0.5;
  }
  // Food is survival, so it outranks everything but a roof; other stockpiles are
  // ordinary work.
  return resourceOfKind(kind) === 'food' ? 0.85 : 0.45;
}

/** Why the settlement wants this. Deterministic, so a rebuilt row matches. */
export function reasonOfKind(kind: string): string {
  const blueprint = blueprintOfKind(kind);
  if (blueprint !== null) return `the settlement has no ${structureTypeOf(blueprint)}`;
  const resource = resourceOfKind(kind);
  if (resource !== null) return `the settlement's ${resource} store is too low`;
  return 'the settlement wants this done';
}

/**
 * A kind rendered as prose: `build:small_shelter` → `a shelter`.
 *
 * Exported because the chronicle needs it. A kind string is an identifier, and
 * identifiers do not belong in history — `the shared work of build:small shelter
 * was finished` is a log line wearing a sentence's clothes.
 */
export function describeKind(kind: string): string {
  const blueprint = blueprintOfKind(kind);
  if (blueprint !== null) return `a ${structureTypeOf(blueprint)}`;
  const resource = resourceOfKind(kind);
  return resource === null ? kind : `a store of ${resource}`;
}

export function describeProject(project: Project): string {
  return describeKind(project.kind);
}

// ── Progress against the shared store ───────────────────────────────────────

export interface ProjectProgress {
  readonly project: Project;
  readonly required: ResourceBundle;
  /**
   * What the shared store can put toward this project. Higher-priority open
   * projects have first call on it, so a farm doesn't believe itself funded by
   * the timber the shelter is about to consume.
   */
  readonly available: ResourceBundle;
  readonly shortfall: ResourceBundle;
  /** 0..1 across every required kind. */
  readonly fraction: number;
  readonly funded: boolean;
}

/** Progress for every open project, in the order they have claim on the store. */
export function openProgress(store: Store): ProjectProgress[] {
  const pools = new Map<SettlementId, ResourceBundle>();
  const out: ProjectProgress[] = [];

  for (const project of store.projects.open()) {
    let pool = pools.get(project.settlementId);
    if (pool === undefined) {
      pool = settlementStock(store, project.settlementId);
    }

    const available: ResourceBundle = {};
    const left: ResourceBundle = {};
    for (const kind of RESOURCE_KINDS) {
      const have = bundleGet(pool, kind);
      const take = Math.min(have, bundleGet(project.requirements, kind));
      if (take > 0) available[kind] = take;
      if (have - take > 0) left[kind] = have - take;
    }
    pools.set(project.settlementId, left);
    out.push(progressFrom(project, available));
  }

  return out;
}

export function progressOf(store: Store, projectId: ProjectId): ProjectProgress | null {
  return openProgress(store).find((progress) => progress.project.id === projectId) ?? null;
}

function progressFrom(project: Project, available: ResourceBundle): ProjectProgress {
  const required = project.requirements;
  const shortfall = bundleShortfall(required, available);
  let needed = 0;
  let covered = 0;
  for (const kind of RESOURCE_KINDS) {
    needed += bundleGet(required, kind);
    covered += Math.min(bundleGet(available, kind), bundleGet(required, kind));
  }
  return {
    project,
    required,
    available,
    shortfall,
    fraction: needed === 0 ? 1 : covered / needed,
    funded: needed === 0 || covered >= needed,
  };
}

// ── Roles: what a project needs hands for ───────────────────────────────────

/**
 * One piece of a project that one or more agents can announce they are doing.
 *
 * Capacity is the mechanism that ends the five-shelters problem: `building` has
 * a capacity of one, so the second agent to look sees it taken. Gathering scales
 * with the size of the shortfall, because two people fetching sixty timbers is
 * sensible and two people laying the same wall is not.
 */
export interface RoleSlot {
  readonly projectId: ProjectId;
  readonly settlementId: SettlementId;
  /** `building`, `siting`, `gathering:wood` — public, and stored on the claim. */
  readonly role: string;
  readonly capacity: number;
  /** Who currently holds it. Public announcements, not anyone's private plan. */
  readonly holders: readonly AgentId[];
  /** The competence this work rewards, used to weight who should take it. */
  readonly skill: Skill;
  /** What the holder should actually go and do now. */
  readonly goal: GoalKind;
  readonly resource: ResourceKind | null;
  readonly quantity: number | null;
  readonly blueprint: string | null;
  readonly priority: number;
  /** First-person fragment for the goal's reason. */
  readonly detail: string;
}

/** Which competence fetching a resource rewards. */
export const RESOURCE_SKILL: Readonly<Record<ResourceKind, Skill>> = {
  wood: 'gathering',
  fiber: 'gathering',
  soil: 'gathering',
  sand: 'gathering',
  stone: 'mining',
  coal: 'mining',
  iron: 'mining',
  food: 'farming',
};

/** How much one pair of hands is worth fetching, before a second is wanted. */
const HANDS_PER_UNIT = 48;
const MAX_HANDS_PER_RESOURCE = 3;

/** Every role on a project, taken or not. */
export function rolesOf(store: Store, progress: ProjectProgress): RoleSlot[] {
  const project = progress.project;
  const claims = store.projects.claimsFor(project.id);
  const holdersByRole = new Map<string, AgentId[]>();
  for (const claim of claims) {
    const held = holdersByRole.get(claim.role) ?? [];
    held.push(claim.agentId);
    holdersByRole.set(claim.role, held);
  }
  const holders = (role: string): readonly AgentId[] => holdersByRole.get(role) ?? [];

  const slots: RoleSlot[] = [];
  const base = { projectId: project.id, settlementId: project.settlementId, priority: project.priority };
  const blueprint = blueprintOfKind(project.kind);
  const what = describeProject(project);

  // Fetching what the shared store still lacks. One slot per resource kind, and a
  // second pair of hands only when the shortfall is genuinely large.
  for (const kind of RESOURCE_KINDS) {
    const short = bundleGet(progress.shortfall, kind);
    if (short <= 0) continue;
    const capacity = Math.min(MAX_HANDS_PER_RESOURCE, 1 + Math.floor(short / HANDS_PER_UNIT));
    const role = `gathering:${kind}`;
    slots.push({
      ...base,
      role,
      capacity,
      holders: holders(role),
      skill: RESOURCE_SKILL[kind],
      goal: kind === 'food' ? 'find_food' : 'gather_resource',
      resource: kind,
      quantity: Math.min(256, Math.max(1, Math.ceil(short / capacity))),
      blueprint: null,
      detail: `${what} needs ${short} more ${kind}`,
    });
  }

  if (blueprint !== null) {
    // Choosing the ground. Only open while nobody has decided where it goes.
    if (project.site === null) {
      slots.push({
        ...base,
        role: 'siting',
        capacity: 1,
        holders: holders('siting'),
        skill: 'exploration',
        goal: 'build_structure',
        resource: null,
        quantity: null,
        blueprint,
        detail: `${what} has no site yet`,
      });
    }

    // The exclusive role. Capacity one, and held from the moment someone takes it
    // on — which is precisely what stops the other four starting their own.
    const scarcest = scarcestKind(progress.shortfall);
    const canStart = progress.funded || scarcest === null;
    slots.push({
      ...base,
      role: 'building',
      capacity: 1,
      holders: holders('building'),
      skill: 'building',
      // A builder whose materials have not arrived does not stand idle holding the
      // role — she fetches the scarcest thing herself. The claim keeps the work
      // hers either way.
      goal: canStart ? 'build_structure' : 'gather_resource',
      resource: canStart ? null : scarcest,
      quantity:
        canStart || scarcest === null
          ? null
          : Math.min(256, Math.max(1, bundleGet(progress.shortfall, scarcest))),
      blueprint,
      detail: canStart
        ? `${what} is paid for and wants building`
        : `${what} is mine to build, and it still needs ${formatBundle(progress.shortfall)}`,
    });
  }

  return slots;
}

/** Every role on every open project. The public work board — assembled from
 *  claims and the ledger, with nobody's private state in it. */
export function openRoles(store: Store): RoleSlot[] {
  return openProgress(store).flatMap((progress) => rolesOf(store, progress));
}

export function isRoleAvailableTo(slot: RoleSlot, agentId: AgentId): boolean {
  return slot.holders.includes(agentId) || slot.holders.length < slot.capacity;
}

function scarcestKind(shortfall: ResourceBundle): ResourceKind | null {
  let worst: ResourceKind | null = null;
  let most = 0;
  for (const kind of RESOURCE_KINDS) {
    const amount = bundleGet(shortfall, kind);
    if (amount > most) {
      most = amount;
      worst = kind;
    }
  }
  return worst;
}

// ── Proposing work ──────────────────────────────────────────────────────────

export interface ProposeOptions {
  readonly settlementId: SettlementId;
  readonly time: TimeContext;
  /**
   * How many projects may be open at once. Two by default: a settlement that
   * announces five simultaneous ambitions has not prioritised, and every extra
   * open project dilutes the claims that make coordination legible.
   */
  readonly maxOpen?: number;
}

/**
 * Propose whatever the settlement visibly lacks, and nothing it already has in
 * hand. Called repeatedly; it only ever adds what is missing.
 */
export function proposeProjects(store: Store, options: ProposeOptions): Project[] {
  const maxOpen = options.maxOpen ?? 2;
  const open = store.projects.open();
  const openKinds = new Set(open.map((project) => project.kind));
  const created: Project[] = [];
  let room = Math.max(0, maxOpen - open.length);
  if (room === 0) return created;

  const wanted: string[] = [];

  // Food first when the store is bare: a settlement that starves does not finish
  // its shelter either.
  const shortOfFood = Math.max(
    0,
    population(store) * FOOD_PER_SETTLER - bundleGet(settlementStock(store, options.settlementId), 'food'),
  );
  if (shortOfFood > 0) wanted.push(stockpileKind('food'));

  const next = nextNeededStructure(store);
  if (next !== null) wanted.push(buildKind(next.blueprint));

  for (const kind of wanted) {
    if (room === 0) break;
    if (openKinds.has(kind)) continue;
    // A structure already built is not proposed again, and a completed stockpile
    // is re-proposed only when the store runs down — which `shortOfFood` above
    // has already decided.
    const project = createProject(store, {
      settlementId: options.settlementId,
      kind,
      time: options.time,
      ...(shortOfFood > 0 && resourceOfKind(kind) === 'food' ? { amount: shortOfFood } : {}),
    });
    created.push(project);
    openKinds.add(kind);
    room -= 1;
  }

  return created;
}

export interface CreateProjectOptions {
  readonly settlementId: SettlementId;
  readonly kind: string;
  readonly time: TimeContext;
  /** For a stockpile: how much is wanted. Ignored for a build. */
  readonly amount?: number;
}

/** Create one project and announce it. Priced from the blueprint (ADR-0004). */
export function createProject(store: Store, options: CreateProjectOptions): Project {
  const { kind } = options;
  const blueprint = blueprintOfKind(kind);
  const resource = resourceOfKind(kind);
  const requirements: ResourceBundle =
    blueprint !== null
      ? costOf(blueprint)
      : resource !== null
        ? { [resource]: Math.max(1, Math.round(options.amount ?? FOOD_PER_SETTLER)) }
        : {};

  const site = blueprint === null ? null : settlementCenter(store);

  const project: Project = {
    id: store.ids.next('proj') as ProjectId,
    settlementId: options.settlementId,
    kind,
    blueprint,
    requirements,
    site,
    state: 'proposed',
    priority: priorityOfKind(kind),
    reason: reasonOfKind(kind),
    createdAtDay: options.time.day,
    createdAtTicks: options.time.worldTicks,
    completedAtTicks: null,
    structureId: null,
  };

  return store.transaction(() => {
    store.projects.insert(project);
    store.events.append(
      {
        type: 'project_created',
        actorId: null,
        payload: {
          settlementId: project.settlementId,
          projectId: project.id,
          kind: project.kind,
          requirements: project.requirements,
        },
      },
      { day: options.time.day, worldTicks: options.time.worldTicks },
    );
    return project;
  });
}

// ── Claims ──────────────────────────────────────────────────────────────────

export interface ClaimOptions {
  readonly projectId: ProjectId;
  readonly agentId: AgentId;
  readonly role: string;
  readonly time: TimeContext;
}

/**
 * Announce that this agent is taking on part of a project.
 *
 * Refuses when the role is already full, which is the whole point: the refusal
 * is what makes the second agent look for different work instead of duplicating
 * the first. Taking a claim also moves a proposed project to active — someone
 * doing it is what makes it real.
 */
export function claimRole(store: Store, options: ClaimOptions): Result<ProjectClaim> {
  const project = store.projects.find(options.projectId);
  if (project === null) {
    return fail('BAD_ARGS', `no project ${options.projectId}`, { retryable: false });
  }
  if (!isActive(project)) {
    return fail('TARGET_CHANGED', `${describeProject(project)} is no longer being worked on`, {
      retryable: false,
    });
  }

  const progress = progressOf(store, project.id);
  const slot =
    progress === null
      ? undefined
      : rolesOf(store, progress).find((candidate) => candidate.role === options.role);
  if (slot === undefined) {
    return fail('TARGET_CHANGED', `${describeProject(project)} has no '${options.role}' to do`, {
      retryable: false,
    });
  }
  if (!isRoleAvailableTo(slot, options.agentId)) {
    return fail('TARGET_CHANGED', `someone else has taken on ${options.role}`, {
      observed: { holders: slot.holders },
      retryable: false,
    });
  }

  return store.transaction(() => {
    store.projects.claim(project.id, options.agentId, options.role, options.time.worldTicks);
    if (project.state === 'proposed') {
      store.projects.update({ ...project, state: 'active' });
    }
    store.events.append(
      {
        type: 'project_claimed',
        actorId: options.agentId,
        payload: { projectId: project.id, agentId: options.agentId, role: options.role },
      },
      { day: options.time.day, worldTicks: options.time.worldTicks },
    );
    const claim = store.projects
      .claimsFor(project.id)
      .find((candidate) => candidate.agentId === options.agentId);
    return claim === undefined
      ? fail<ProjectClaim>('INTERNAL', 'the claim did not stick')
      : ok(claim);
  });
}

/** Give up a claim, freeing the role for someone else. */
export function releaseClaim(
  store: Store,
  projectId: ProjectId,
  agentId: AgentId,
  atTicks: number,
): void {
  store.projects.release(projectId, agentId, atTicks);
}

/** Give up everything this agent had taken on — what an agent that has stopped
 *  doing settlement work owes the others. */
export function releaseClaimsBy(store: Store, agentId: AgentId, atTicks: number): number {
  const claims = store.projects.claimsBy(agentId);
  for (const claim of claims) store.projects.release(claim.projectId, agentId, atTicks);
  return claims.length;
}

/** What this agent has publicly taken on. */
export function claimsBy(store: Store, agentId: AgentId): ProjectClaim[] {
  return store.projects.claimsBy(agentId);
}

// ── Contributions ───────────────────────────────────────────────────────────

export interface ContributeOptions {
  readonly projectId: ProjectId;
  readonly agentId: AgentId;
  readonly time: TimeContext;
  /** What to hand over. Defaults to as much of the shortfall as the agent has. */
  readonly resources?: ResourceBundle;
}

export interface Contribution {
  readonly applied: ResourceBundle;
  readonly progress: ProjectProgress;
}

/**
 * Hand resources to the settlement for a project.
 *
 * The resources move in the ledger — out of the agent, into the settlement — so
 * a contribution costs the giver something real, and the same event that records
 * it is what a rebuild reads back (ADR-0004).
 */
export function contribute(store: Store, options: ContributeOptions): Result<Contribution> {
  const project = store.projects.find(options.projectId);
  if (project === null) {
    return fail('BAD_ARGS', `no project ${options.projectId}`, { retryable: false });
  }
  if (!isActive(project)) {
    return fail('TARGET_CHANGED', `${describeProject(project)} is finished`, { retryable: false });
  }

  const before = progressOf(store, project.id);
  if (before === null) {
    return fail('TARGET_CHANGED', `${describeProject(project)} is no longer open`, {
      retryable: false,
    });
  }

  const carrying = store.ledger.balance(agentOwner(options.agentId));
  const wanted = options.resources ?? before.shortfall;
  const applied: ResourceBundle = {};
  for (const kind of RESOURCE_KINDS) {
    // Never take more than the project still needs, and never more than the agent
    // actually has — a contribution the ledger cannot cover is not a contribution.
    const amount = Math.min(
      bundleGet(wanted, kind),
      bundleGet(carrying, kind),
      bundleGet(before.shortfall, kind),
    );
    if (amount > 0) applied[kind] = amount;
  }

  if (RESOURCE_KINDS.every((kind) => bundleGet(applied, kind) === 0)) {
    return fail('BAD_ARGS', `nothing this settler carries is wanted for ${describeProject(project)}`, {
      observed: { carrying, shortfall: before.shortfall },
      retryable: false,
    });
  }

  return store.transaction(() => {
    const moved = store.ledger.transfer(
      agentOwner(options.agentId),
      settlementOwner(project.settlementId),
      applied,
    );
    if (!moved.ok) return moved as Result<never>;

    store.events.append(
      {
        type: 'resource_deposited',
        actorId: options.agentId,
        payload: {
          agentId: options.agentId,
          settlementId: project.settlementId,
          resources: applied,
        },
      },
      { day: options.time.day, worldTicks: options.time.worldTicks },
    );

    const after = progressOf(store, project.id);
    return ok({ applied, progress: after ?? before });
  });
}

export interface WithdrawOptions {
  readonly projectId: ProjectId;
  readonly agentId: AgentId;
  readonly time: TimeContext;
}

/**
 * Draw a build's materials out of the shared store and into the builder's hands.
 *
 * Without this, contributing is a dead end: gatherers fill a store nobody can
 * spend, and the builder can only build what she fetched herself — which is the
 * five-shelters problem wearing a different hat. Only what the builder is short
 * of moves, so the store keeps whatever she already carries.
 */
export function withdrawForBuild(store: Store, options: WithdrawOptions): Result<ResourceBundle> {
  const project = store.projects.find(options.projectId);
  if (project === null) {
    return fail('BAD_ARGS', `no project ${options.projectId}`, { retryable: false });
  }
  if (project.blueprint === null) {
    return fail('BAD_ARGS', `${describeProject(project)} is not a build`, { retryable: false });
  }

  const cost = costOf(project.blueprint);
  const carrying = store.ledger.balance(agentOwner(options.agentId));
  const needed = bundleShortfall(cost, carrying);
  if (RESOURCE_KINDS.every((kind) => bundleGet(needed, kind) === 0)) {
    return ok({});
  }

  return store.transaction(() => {
    const moved = store.ledger.transfer(
      settlementOwner(project.settlementId),
      agentOwner(options.agentId),
      needed,
    );
    if (!moved.ok) return moved as Result<never>;

    store.events.append(
      {
        type: 'resource_withdrawn',
        actorId: options.agentId,
        payload: {
          agentId: options.agentId,
          settlementId: project.settlementId,
          resources: needed,
          reason: `building ${describeProject(project)}`,
        },
      },
      { day: options.time.day, worldTicks: options.time.worldTicks },
    );
    return ok(needed);
  });
}

// ── Completion ──────────────────────────────────────────────────────────────

export interface CompleteOptions {
  readonly projectId: ProjectId;
  readonly time: TimeContext;
  /** The structure the project produced, when it produced one. */
  readonly structureId?: StructureId;
  readonly byAgentId?: AgentId;
}

/**
 * Close a project because what it asked for now exists.
 *
 * Completing twice fails rather than emitting a second `project_completed` — the
 * chronicle would otherwise report the shelter finished on two different days.
 */
export function completeProject(store: Store, options: CompleteOptions): Result<Project> {
  const project = store.projects.find(options.projectId);
  if (project === null) {
    return fail('BAD_ARGS', `no project ${options.projectId}`, { retryable: false });
  }
  if (project.state === 'completed') {
    return fail('TARGET_CHANGED', `${describeProject(project)} was already finished`, {
      retryable: false,
    });
  }

  const completed: Project = {
    ...project,
    state: 'completed',
    completedAtTicks: options.time.worldTicks,
    structureId: options.structureId ?? project.structureId,
  };

  return store.transaction(() => {
    store.projects.update(completed);
    // The work is done, so nobody is doing it any more.
    for (const claim of store.projects.claimsFor(project.id)) {
      store.projects.release(project.id, claim.agentId, options.time.worldTicks);
    }
    store.events.append(
      {
        type: 'project_completed',
        actorId: options.byAgentId ?? null,
        payload: { projectId: project.id, kind: project.kind },
      },
      { day: options.time.day, worldTicks: options.time.worldTicks },
    );
    return ok(completed);
  });
}

/**
 * Close whichever open project a newly verified structure satisfies.
 *
 * The structure is the evidence — the project completes because the world was
 * read back and found to contain what was asked for, not because someone said so.
 */
export function completeProjectsFor(
  store: Store,
  structure: Structure,
  time: TimeContext,
): Project[] {
  const closed: Project[] = [];
  for (const project of store.projects.open()) {
    const blueprint = blueprintOfKind(project.kind);
    if (blueprint === null) continue;
    if (blueprint !== structure.blueprint && structureTypeOf(blueprint) !== structure.type) continue;

    const builder = structure.builders[0];
    const result = completeProject(store, {
      projectId: project.id,
      time,
      structureId: structure.id,
      ...(builder === undefined ? {} : { byAgentId: builder }),
    });
    if (result.ok) closed.push(result.value);
    // One structure satisfies one project.
    break;
  }
  return closed;
}

/** Close a stockpile whose target the shared store has reached. */
export function completeFundedStockpiles(store: Store, time: TimeContext): Project[] {
  const closed: Project[] = [];
  for (const progress of openProgress(store)) {
    if (resourceOfKind(progress.project.kind) === null || !progress.funded) continue;
    const result = completeProject(store, { projectId: progress.project.id, time });
    if (result.ok) closed.push(result.value);
  }
  return closed;
}

// ── Rebuilding the projection ───────────────────────────────────────────────

/**
 * Rebuild project rows and claims from the event ledger.
 *
 * Everything a project row holds is either in `project_created` or derivable from
 * its kind, which is why the kind carries the blueprint. Two things the ledger
 * does not record, reported as gaps rather than silently invented:
 *
 *  - a released claim (there is no `project_released` event), so a rebuild shows
 *    every claim ever announced as still live;
 *  - which structure a completed project produced, which is recovered by taking
 *    the last matching structure completed before the project closed.
 */
export function reconcileProjects(store: Store): ReconcileReport {
  const events = store.events.query({
    types: ['project_created', 'project_claimed', 'project_completed', 'structure_completed'],
  });

  return store.transaction(() => {
    let projects = 0;
    let claims = 0;
    const gaps: string[] = [];
    /** Last structure completed of each type, for relinking completions. */
    const lastStructure = new Map<string, { id: StructureId; blueprint: string }>();

    for (const event of events) {
      switch (event.type) {
        case 'structure_completed': {
          const payload = event.payload as {
            structureId: StructureId;
            type: string;
          };
          const structure = store.structures.find(payload.structureId);
          lastStructure.set(payload.type, {
            id: payload.structureId,
            blueprint: structure?.blueprint ?? payload.type,
          });
          break;
        }

        case 'project_created': {
          const payload = event.payload as {
            settlementId: SettlementId;
            projectId: ProjectId;
            kind: string;
            requirements: ResourceBundle;
          };
          if (store.projects.find(payload.projectId) !== null) break;
          const blueprint = blueprintOfKind(payload.kind);
          store.projects.insert({
            id: payload.projectId,
            settlementId: payload.settlementId,
            kind: payload.kind,
            blueprint,
            requirements: payload.requirements,
            site: blueprint === null ? null : settlementCenter(store),
            state: 'proposed',
            priority: priorityOfKind(payload.kind),
            reason: reasonOfKind(payload.kind),
            createdAtDay: event.day,
            createdAtTicks: event.worldTicks,
            completedAtTicks: null,
            structureId: null,
          });
          projects += 1;
          break;
        }

        case 'project_claimed': {
          const payload = event.payload as { projectId: ProjectId; agentId: AgentId; role: string };
          const project = store.projects.find(payload.projectId);
          if (project === null) {
            gaps.push(`claim on unknown project ${payload.projectId}`);
            break;
          }
          store.projects.claim(project.id, payload.agentId, payload.role, event.worldTicks);
          if (project.state === 'proposed') {
            store.projects.update({ ...project, state: 'active' });
          }
          claims += 1;
          break;
        }

        case 'project_completed': {
          const payload = event.payload as { projectId: ProjectId; kind: string };
          const project = store.projects.find(payload.projectId);
          if (project === null) {
            gaps.push(`completion of unknown project ${payload.projectId}`);
            break;
          }
          const blueprint = blueprintOfKind(project.kind);
          const produced =
            blueprint === null ? undefined : lastStructure.get(structureTypeOf(blueprint));
          store.projects.update({
            ...project,
            state: 'completed',
            completedAtTicks: event.worldTicks,
            structureId: produced?.id ?? null,
          });
          for (const claim of store.projects.claimsFor(project.id)) {
            store.projects.release(project.id, claim.agentId, event.worldTicks);
          }
          break;
        }

        default:
          break;
      }
    }

    return {
      settlements: store.settlements.all().length,
      structures: store.structures.count(),
      projects,
      claims,
      gaps,
    };
  });
}

/**
 * Rebuild the whole civilization projection from the ledger.
 *
 * Lives here rather than in settlement.ts because this is the module that can see
 * both halves: settlements and structures first, then the projects that reference
 * them.
 */
export function reconcileCivilization(
  store: Store,
  options: ReconcileOptions = {},
): ReconcileReport {
  return store.transaction(() => {
    const settlements = reconcileSettlementState(store, options);
    const projects = reconcileProjects(store);
    return {
      settlements: projects.settlements,
      structures: settlements.structures,
      projects: projects.projects,
      claims: projects.claims,
      gaps: [...settlements.gaps, ...projects.gaps],
    };
  });
}
