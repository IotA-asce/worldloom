/**
 * Deterministic action executors — one per `ActionKind`.
 *
 * This is where the causal chain is actually enforced, so a few rules hold
 * throughout:
 *
 *  - **The ledger is credited only from what the environment verified.** Every
 *    harvest credits `result.gained`, which the adapter computed from blocks it
 *    read back, never from what the plan asked for (ADR-0004).
 *  - **Executors talk to each other through knowledge, not through the plan.**
 *    `locate_resource` writes what it found into the agent's beliefs;
 *    `harvest_resource` reads them. That keeps steps independent, survives a
 *    restart between them, and means the agent's knowledge explains its actions.
 *  - **Failure teaches.** A harvest that finds nothing lowers the confidence of
 *    the belief that sent the agent there, so replanning doesn't send it back.
 *  - Each executor appends its own events inside a transaction with its own
 *    writes, so an event and the ledger change it describes can't diverge.
 */

import type { Agent } from '../agents/agent.ts';
import { agentView, clamp01 } from '../agents/agent.ts';
import { structureTypeOf } from '../civilization/blueprints.ts';
import { findBlueprint } from '../civilization/blueprints.ts';
import { applyStructureCompleted } from '../civilization/settlement.ts';
import { tell } from '../agents/messaging.ts';
import { completeProjectsFor, contribute, withdrawForBuild } from '../civilization/projects.ts';
import type { StructureId } from '../core/ids.ts';
import { fail, ok, type Result } from '../core/result.ts';
import {
  blueprintCost,
  blueprintRegion,
  bundleGet,
  bundleIsEmpty,
  formatBundle,
  formatPosition,
  horizontalDistance,
  region as makeRegion,
  regionCenter,
  regionsOverlap,
  RESOURCE_KINDS,
  type Position,
  type Region,
  type ResourceKind,
  type SurveyCell,
  type WorldTime,
} from '../core/world.ts';
import type { Environment } from '../environment/port.ts';
import type { NewEvent } from '../events/types.ts';
import { OBSERVED, type LocationKind } from '../memory/types.ts';
import { agentOwner } from '../persistence/repositories/ledger.ts';
import type { Store } from '../persistence/store.ts';
import type { Goal } from './goal.ts';
import type { ActionParams, PlanStep, TravelTarget } from './plan.ts';

export interface ExecutionContext {
  readonly store: Store;
  readonly environment: Environment;
  readonly agent: Agent;
  readonly goal: Goal;
  readonly time: WorldTime;
}

export interface StepOutcome {
  /** A short human-readable account of what happened, stored on the step. */
  readonly note: string;
  /** Agent fields that changed as a result. */
  readonly agentPatch?: Partial<Agent>;
  /** True when the step turned out to be unnecessary rather than done. */
  readonly skipped?: boolean;
  /**
   * True when the step made real progress but is not finished — a long walk
   * covered partly. Neither success nor failure: the step stays current and is
   * continued next tick, which is how travel across broken ground works without
   * either lying about arrival or abandoning the goal.
   */
  readonly incomplete?: boolean;
}

type Ctx = ExecutionContext;

/** Dispatch a step to its executor. */
export async function executeStep(step: PlanStep, ctx: Ctx): Promise<Result<StepOutcome>> {
  switch (step.action) {
    case 'survey_area':
      return surveyArea(step.params as ActionParams['survey_area'], ctx);
    case 'travel_to':
      return travelTo(step.params as ActionParams['travel_to'], ctx);
    case 'locate_resource':
      return locateResource(step.params as ActionParams['locate_resource'], ctx);
    case 'harvest_resource':
      return harvestResource(step.params as ActionParams['harvest_resource'], ctx);
    case 'select_site':
      return selectSite(step.params as ActionParams['select_site'], ctx);
    case 'reserve_region':
      return reserveRegion(step.params as ActionParams['reserve_region'], ctx);
    case 'clear_site':
      return clearSite(step.params as ActionParams['clear_site'], ctx);
    case 'place_blueprint':
      return placeBlueprint(step.params as ActionParams['place_blueprint'], ctx);
    case 'verify_structure':
      return verifyStructure(step.params as ActionParams['verify_structure'], ctx);
    case 'release_region':
      return releaseRegion(step.params as ActionParams['release_region'], ctx);
    case 'deposit_resources':
      return depositResources(ctx);
    case 'send_message':
      return sendMessage(step.params as ActionParams['send_message'], ctx);
    case 'rest':
      return rest(step.params as ActionParams['rest'], ctx);
    case 'eat':
      return eat(step.params as ActionParams['eat'], ctx);
  }
}

// ── Sensing ─────────────────────────────────────────────────────────────────

async function surveyArea(params: ActionParams['survey_area'], ctx: Ctx): Promise<Result<StepOutcome>> {
  const survey = await ctx.environment.surveyRegion(params.region, params.resolution ?? 4);
  if (!survey.ok) return survey;

  const landmarks = classifyTerrain(survey.value.cells);
  const events: NewEvent[] = [];

  ctx.store.transaction(() => {
    for (const landmark of landmarks) {
      const already = ctx.store.knowledge.knowsLocation(ctx.agent.id, landmark.position, landmark.kind);
      ctx.store.knowledge.rememberLocation({
        agentId: ctx.agent.id,
        position: landmark.position,
        kind: landmark.kind,
        confidence: 0.8,
        source: OBSERVED,
        label: landmark.label,
        discoveredAtDay: ctx.time.day,
        lastSeenAtTicks: ctx.time.totalTicks,
      });
      // Only genuinely new knowledge is an event; re-seeing a hill is not news.
      if (!already) {
        events.push({
          type: 'location_discovered',
          actorId: ctx.agent.id,
          payload: {
            agentId: ctx.agent.id,
            at: landmark.position,
            kind: landmark.kind,
            confidence: 0.8,
          },
        });
      }
    }
    appendAll(ctx, events);
  });

  return ok({
    note:
      events.length > 0
        ? `surveyed ${survey.value.cells.length} points and found ${events.length} new place(s) of interest`
        : `surveyed ${survey.value.cells.length} points; nothing new`,
    agentPatch: { status: 'exploring', activity: 'surveying the land' },
  });
}

async function locateResource(
  params: ActionParams['locate_resource'],
  ctx: Ctx,
): Promise<Result<StepOutcome>> {
  const observation = await ctx.environment.observe(agentView(ctx.agent), params.searchRadius);
  if (!observation.ok) return observation;

  const found = observation.value.visibleResources.filter(
    (visible) => visible.resource === params.resource,
  );

  if (found.length === 0) {
    // Honest failure: the agent looked and there was nothing there. The planner
    // reads this and tries somewhere else.
    return fail(
      'RESOURCE_UNAVAILABLE',
      `no ${params.resource} visible within ${params.searchRadius} blocks`,
      { observed: { searchRadius: params.searchRadius, at: ctx.agent.position } },
    );
  }

  // Has the settlement ever known of this resource? Asked of the ledger rather
  // than of another agent's mind — a `resource_discovered` event is public
  // history, not private belief. One sweep can reveal four seams at once, so the
  // flag is consumed by the first event it marks: a first strike is one moment in
  // history, not four.
  let firstOfItsKind =
    ctx.store.events
      .query({ types: ['resource_discovered'] })
      .every((event) => (event.payload as { resource?: string }).resource !== params.resource);

  const events: NewEvent[] = [];
  ctx.store.transaction(() => {
    for (const visible of found.slice(0, 4)) {
      const known = ctx.store.knowledge
        .knownResources(ctx.agent.id, params.resource)
        .some((existing) => horizontalDistance(existing.position, visible.position) < 8);

      ctx.store.knowledge.rememberResource({
        agentId: ctx.agent.id,
        resource: visible.resource,
        position: visible.position,
        estimatedQuantity: visible.estimatedQuantity,
        confidence: 0.9,
        source: OBSERVED,
        discoveredAtDay: ctx.time.day,
        lastSeenAtTicks: ctx.time.totalTicks,
      });

      if (!known) {
        events.push({
          type: 'resource_discovered',
          actorId: ctx.agent.id,
          payload: {
            agentId: ctx.agent.id,
            resource: visible.resource,
            at: visible.position,
            estimatedQuantity: visible.estimatedQuantity,
          },
          // The settlement's first knowledge of a resource is a genuine
          // milestone; a later find of something already known is routine. Both
          // are recorded, but only the first is offered to history.
          ...(firstOfItsKind ? { importance: 0.85 } : {}),
        });
        firstOfItsKind = false;
      }
    }
    appendAll(ctx, events);
  });

  const best = found[0]!;
  const told = shareDiscovery(ctx, params.resource, best, events.length > 0);

  return ok({
    note:
      told === null
        ? `found ${params.resource} near ${formatPosition(best.position)}`
        : `found ${params.resource} near ${formatPosition(best.position)} and told ${told}`,
    agentPatch: { status: 'exploring', activity: `looking for ${params.resource}` },
  });
}

/**
 * Pass on a genuinely new find to someone nearby.
 *
 * This is how knowledge spreads at all (requirement 10). Without it agents only
 * ever learn by looking, `knowledge_shared` never fires in a real run, and the
 * only relationship movement is the negative kind from competing over ground —
 * which makes the social layer look broken when it is merely unused.
 *
 * It happens here rather than as its own goal because that is how people behave:
 * you call out "there's iron over here" while you are standing on it, you do not
 * form an intention to hold a meeting about it later.
 */
function shareDiscovery(
  ctx: Ctx,
  resource: ResourceKind,
  found: { position: Position; estimatedQuantity: number },
  wasNews: boolean,
): string | null {
  // Only real news, and only if this settler is the sort to mention it.
  if (!wasNews) return null;
  if (ctx.agent.personality.sociability < 0.35) return null;

  // Tell whoever is nearest — the only agent this one can see well enough to
  // speak to. Position is public; their beliefs are not.
  let nearest: { id: typeof ctx.agent.id; name: string } | null = null;
  let bestDistance = TALKING_DISTANCE;
  for (const other of ctx.store.agents.living()) {
    if (other.id === ctx.agent.id) continue;
    const distance = horizontalDistance(ctx.agent.position, other.position);
    if (distance <= bestDistance) {
      bestDistance = distance;
      nearest = { id: other.id, name: other.name };
    }
  }
  if (nearest === null) return null;

  const sent = tell(
    { store: ctx.store, time: ctx.time },
    {
      fromAgentId: ctx.agent.id,
      toAgentId: nearest.id,
      intent: {
        kind: 'discovery',
        subject: `${resource} near ${formatPosition(found.position)}`,
        at: found.position,
        resource,
        estimatedQuantity: found.estimatedQuantity,
      },
    },
  );

  return sent.ok ? nearest.name : null;
}

/** How far away someone can still be told something. */
const TALKING_DISTANCE = 48;

// ── Movement ────────────────────────────────────────────────────────────────

async function travelTo(params: ActionParams['travel_to'], ctx: Ctx): Promise<Result<StepOutcome>> {
  const destination = resolveTarget(params.target, ctx);
  if (destination === null) {
    return fail(
      'TARGET_CHANGED',
      `nowhere known to travel to for ${describeTarget(params.target)}`,
      { retryable: false },
    );
  }

  if (horizontalDistance(ctx.agent.position, destination) <= 2) {
    return ok({ note: 'already there', skipped: true });
  }

  const moved = await ctx.environment.moveAgent(agentView(ctx.agent), destination);
  if (!moved.ok) return moved;

  const result = moved.value;
  ctx.store.transaction(() => {
    appendAll(ctx, [
      {
        type: 'agent_moved',
        actorId: ctx.agent.id,
        payload: { agentId: ctx.agent.id, from: result.from, to: result.to },
      },
    ]);
  });

  const patch: Partial<Agent> = {
    position: result.to,
    status: 'traveling',
    activity: `travelling toward ${formatPosition(destination)}`,
  };

  if (!result.arrived) {
    // Going nowhere is a genuine failure the planner must hear about. Going
    // *some* of the way is progress, and reporting it as failure would make
    // ordinary broken terrain look like an impossible goal.
    if (result.distance < 1) {
      return fail(
        'PATH_BLOCKED',
        `cannot make any headway toward ${formatPosition(destination)}`,
        { observed: { reached: result.to }, retryable: false },
      );
    }
    return ok({
      note: `moved ${Math.round(result.distance)} blocks toward ${formatPosition(destination)}`,
      agentPatch: patch,
      incomplete: true,
    });
  }

  return ok({ note: `travelled ${Math.round(result.distance)} blocks`, agentPatch: patch });
}

function resolveTarget(target: TravelTarget, ctx: Ctx): Position | null {
  switch (target.kind) {
    case 'position':
      return target.position;
    case 'resource': {
      const known = ctx.store.knowledge.knownResources(ctx.agent.id, target.resource);
      let best: Position | null = null;
      let bestDistance = Infinity;
      for (const candidate of known) {
        const distance = horizontalDistance(ctx.agent.position, candidate.position);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = candidate.position;
        }
      }
      return best;
    }
    case 'location': {
      const nearest = ctx.store.knowledge.nearestLocation(
        ctx.agent.id,
        target.location as LocationKind,
        ctx.agent.position,
      );
      return nearest?.position ?? null;
    }
  }
}

function describeTarget(target: TravelTarget): string {
  switch (target.kind) {
    case 'position':
      return formatPosition(target.position);
    case 'resource':
      return `the nearest known ${target.resource}`;
    case 'location':
      return `the nearest known ${target.location}`;
  }
}

// ── Gathering ───────────────────────────────────────────────────────────────

async function harvestResource(
  params: ActionParams['harvest_resource'],
  ctx: Ctx,
): Promise<Result<StepOutcome>> {
  const target = params.from !== undefined
    ? { region: params.from, believedAt: regionCenter(params.from) }
    : harvestRegionFor(params.resource, ctx);
  if (target === null) {
    return fail('RESOURCE_UNAVAILABLE', `I don't know where to find ${params.resource}`, {
      retryable: false,
    });
  }
  const { region, believedAt } = target;

  const result = await ctx.environment.harvest(
    agentView(ctx.agent),
    region,
    params.resource,
    params.quantity,
  );

  if (!result.ok) {
    // The attempt taught the agent something: whatever it believed about this
    // spot was wrong. Correcting the belief is what stops replanning from
    // sending it straight back (ADR-0008).
    if (result.failure.kind === 'RESOURCE_UNAVAILABLE') {
      // Correct the belief at *its own* coordinates. Using the search volume's
      // centre instead misses the stored row by a block or two and the agent
      // never learns — it just walks back next time.
      ctx.store.knowledge.correctResourceBelief(
        ctx.agent.id,
        params.resource,
        believedAt,
        0,
        0,
      );
    }
    return result;
  }

  const harvest = result.value;
  const gained = bundleGet(harvest.gained, params.resource);

  ctx.store.transaction(() => {
    // Credit only what the environment confirmed removed.
    ctx.store.ledger.credit(agentOwner(ctx.agent.id), harvest.gained);

    appendAll(ctx, [
      {
        type: 'resource_collected',
        actorId: ctx.agent.id,
        payload: {
          agentId: ctx.agent.id,
          resource: params.resource,
          quantity: gained,
          from: region,
          verifiedSample: harvest.verifiedSample,
        },
      },
    ]);

    // Deposits the harvest exhausted are no longer worth walking to.
    for (const position of harvest.exhausted) {
      ctx.store.knowledge.correctResourceBelief(ctx.agent.id, params.resource, position, 0, 0);
    }
  });

  return ok({
    note: `gathered ${gained} ${params.resource} (verified from ${harvest.verifiedSample} samples)`,
    agentPatch: { status: 'gathering', activity: `gathering ${params.resource}` },
  });
}

/** A volume around the nearest believed deposit, plus that belief's own
 *  position so a failure can be attributed back to it. */
function harvestRegionFor(
  resource: ResourceKind,
  ctx: Ctx,
): { region: Region; believedAt: Position } | null {
  const known = ctx.store.knowledge.knownResources(ctx.agent.id, resource);
  let best: Position | null = null;
  let bestDistance = Infinity;
  for (const candidate of known) {
    const distance = horizontalDistance(ctx.agent.position, candidate.position);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate.position;
    }
  }
  if (best === null) return null;

  // Reach for a modest volume: wide enough to hold a stand of trees or a seam,
  // small enough that a survey-and-verify cycle stays cheap.
  return {
    region: makeRegion(
      { x: best.x - 12, y: best.y - 6, z: best.z - 12 },
      { x: best.x + 12, y: best.y + 8, z: best.z + 12 },
    ),
    believedAt: best,
  };
}

// ── Building ────────────────────────────────────────────────────────────────

async function selectSite(
  params: ActionParams['select_site'],
  ctx: Ctx,
): Promise<Result<StepOutcome>> {
  const blueprint = findBlueprint(params.blueprint);
  if (blueprint === null) {
    return fail('BAD_ARGS', `unknown blueprint '${params.blueprint}'`, { retryable: false });
  }

  const anchor = params.near ?? ctx.agent.position;
  const searchRegion = makeRegion(
    { x: anchor.x - params.searchRadius, y: anchor.y - 32, z: anchor.z - params.searchRadius },
    { x: anchor.x + params.searchRadius, y: anchor.y + 32, z: anchor.z + params.searchRadius },
  );

  const survey = await ctx.environment.surveyRegion(searchRegion, 2);
  if (!survey.ok) return survey;

  const site = chooseFlattestSite(survey.value.cells, blueprint.size.width, blueprint.size.depth);
  if (site === null) {
    return fail('TARGET_CHANGED', 'no flat, dry ground here to build on', {
      observed: { searchRegion },
    });
  }

  ctx.store.transaction(() => {
    // Recorded as a build site specifically, because the next plan step travels
    // to "the nearest known build_site" — filing it as a generic landmark leaves
    // the agent unable to walk to the spot it just chose.
    ctx.store.knowledge.rememberLocation({
      agentId: ctx.agent.id,
      position: site,
      kind: 'build_site',
      confidence: 1,
      source: OBSERVED,
      label: `site for ${params.blueprint}`,
      discoveredAtDay: ctx.time.day,
      lastSeenAtTicks: ctx.time.totalTicks,
    });
  });

  return ok({
    note: `chose a site at ${formatPosition(site)}`,
    agentPatch: { activity: `siting the ${structureTypeOf(params.blueprint)}` },
  });
}

async function reserveRegion(
  params: ActionParams['reserve_region'],
  ctx: Ctx,
): Promise<Result<StepOutcome>> {
  // Region reservations prevent two agents writing the same blocks (ADR-0005).
  // A refusal is a legitimate planning outcome, not an error.
  const held = ctx.store.db
    .prepare(
      `SELECT agent_id, min_x, min_y, min_z, max_x, max_y, max_z FROM reservations
        WHERE expires_at_ticks > ? AND agent_id <> ?`,
    )
    .all(ctx.time.totalTicks, ctx.agent.id);

  for (const row of held) {
    const other: Region = {
      min: { x: Number(row.min_x), y: Number(row.min_y), z: Number(row.min_z) },
      max: { x: Number(row.max_x), y: Number(row.max_y), z: Number(row.max_z) },
    };
    if (regionsOverlap(params.region, other)) {
      return fail('REGION_RESERVED', `${String(row.agent_id)} is already working there`, {
        observed: { region: other, heldBy: row.agent_id },
        retryable: false,
      });
    }
  }

  const id = ctx.store.ids.next('resv');
  ctx.store.db
    .prepare(
      `INSERT INTO reservations (id, agent_id, min_x, min_y, min_z, max_x, max_y, max_z,
                                purpose, created_at_ticks, expires_at_ticks)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      ctx.agent.id,
      params.region.min.x,
      params.region.min.y,
      params.region.min.z,
      params.region.max.x,
      params.region.max.y,
      params.region.max.z,
      `${ctx.goal.kind}:${ctx.goal.id}`,
      ctx.time.totalTicks,
      // Expiry so a dead agent can't hold a build site forever.
      ctx.time.totalTicks + 12_000,
    );

  return ok({ note: 'claimed the site' });
}

async function releaseRegion(
  _params: ActionParams['release_region'],
  ctx: Ctx,
): Promise<Result<StepOutcome>> {
  const result = ctx.store.db
    .prepare('DELETE FROM reservations WHERE agent_id = ?')
    .run(ctx.agent.id);
  return ok({ note: `released ${String(Number(result.changes))} claim(s)` });
}

async function clearSite(params: ActionParams['clear_site'], ctx: Ctx): Promise<Result<StepOutcome>> {
  const result = await ctx.environment.clearRegion(agentView(ctx.agent), params.region);
  if (!result.ok) return result;
  return ok({
    note: `cleared ${result.value.blocksPlaced} blocks of ground`,
    agentPatch: { status: 'building', activity: 'clearing the site' },
  });
}

async function placeBlueprint(
  params: ActionParams['place_blueprint'],
  ctx: Ctx,
): Promise<Result<StepOutcome>> {
  const blueprint = findBlueprint(params.blueprint);
  if (blueprint === null) {
    return fail('BAD_ARGS', `unknown blueprint '${params.blueprint}'`, { retryable: false });
  }

  const cost = blueprintCost(blueprint);
  const owner = agentOwner(ctx.agent.id);

  // Draw the price from the settlement's stores first, if this agent holds the
  // building claim on a project for exactly this structure. Without it the
  // gatherers fill a store nobody can spend, and a builder can only ever raise
  // what she fetched herself — which defeats the point of shared projects.
  if (!ctx.store.ledger.canAfford(owner, cost)) {
    const claim = ctx.store.projects
      .claimsBy(ctx.agent.id)
      .find((held) => held.role === 'building');
    if (claim !== undefined) {
      const project = ctx.store.projects.find(claim.projectId);
      if (project !== null && project.blueprint === params.blueprint) {
        withdrawForBuild(ctx.store, {
          projectId: project.id,
          agentId: ctx.agent.id,
          time: { day: ctx.time.day, worldTicks: ctx.time.totalTicks },
        });
      }
    }
  }

  // Check before building: an agent cannot raise a wall out of resources it
  // never gathered (ADR-0004). This failure is what sends the planner back to
  // gathering rather than letting the build silently succeed.
  if (!ctx.store.ledger.canAfford(owner, cost)) {
    const have = ctx.store.ledger.balance(owner);
    return fail(
      'INSUFFICIENT_RESOURCES',
      `the ${params.blueprint} needs ${formatBundle(cost)} and I have ${formatBundle(have)}`,
      { observed: { needed: cost, have }, retryable: false },
    );
  }

  const structureId = ctx.store.ids.next('struct') as StructureId;
  const region = blueprintRegion(blueprint, params.origin);

  ctx.store.transaction(() => {
    appendAll(ctx, [
      {
        type: 'structure_started',
        actorId: ctx.agent.id,
        payload: {
          agentId: ctx.agent.id,
          structureId,
          type: structureTypeOf(params.blueprint),
          region,
        },
      },
    ]);
  });

  const built = await ctx.environment.build(agentView(ctx.agent), blueprint, params.origin);
  if (!built.ok) return built;

  const result = built.value;
  const structural = blueprint.blocks.filter((block) => block.material !== 'empty').length;
  // Charge for the proportion that actually landed, so a partial build costs
  // partially rather than either free or full.
  const placedRatio = structural === 0 ? 1 : result.blocksPlaced / structural;
  const charged = scaleBundle(cost, placedRatio);

  ctx.store.transaction(() => {
    const debited = ctx.store.ledger.debit(owner, charged);
    if (debited.ok) {
      appendAll(ctx, [
        {
          type: 'resource_spent',
          actorId: ctx.agent.id,
          payload: {
            agentId: ctx.agent.id,
            resources: charged,
            reason: `building the ${structureTypeOf(params.blueprint)}`,
          },
        },
      ]);
    }
  });

  if (!result.complete) {
    return fail(
      'VERIFICATION_FAILED',
      `the ${params.blueprint} is only partly standing (${result.blocksPlaced}/${structural} blocks)`,
      { observed: { placed: result.blocksPlaced, expected: structural } },
    );
  }

  return ok({
    note: `built the ${structureTypeOf(params.blueprint)} at ${formatPosition(params.origin)}`,
    agentPatch: { status: 'building', activity: `building the ${structureTypeOf(params.blueprint)}` },
  });
}

async function verifyStructure(
  params: ActionParams['verify_structure'],
  ctx: Ctx,
): Promise<Result<StepOutcome>> {
  const blueprint = findBlueprint(params.blueprint);
  if (blueprint === null) {
    return fail('BAD_ARGS', `unknown blueprint '${params.blueprint}'`, { retryable: false });
  }

  // Read the world back rather than trusting the build report — silent write
  // failures are a real possibility (constraint C5).
  const verified = await ctx.environment.verifyBuild(blueprint, params.origin);
  if (!verified.ok) return verified;

  if (!verified.value.complete) {
    return fail('VERIFICATION_FAILED', `the ${params.blueprint} did not survive inspection`, {
      observed: { placed: verified.value.blocksPlaced, failed: verified.value.blocksFailed },
    });
  }

  const type = structureTypeOf(params.blueprint);

  // Somebody may already have finished this exact structure — five settlers who
  // each adopted a build goal before the first one landed will all verify the
  // same walls. Recording a second row would give the settlement thirty-nine
  // shelters at one address and a chronicle full of phantom construction, so an
  // existing structure is *joined* instead: the agent is added as a builder.
  const already = ctx.store.structures
    .overlapping(verified.value.region)
    .find((candidate) => candidate.type === type && candidate.state === 'complete');

  if (already !== null && already !== undefined) {
    ctx.store.structures.addBuilder(already.id, ctx.agent.id);
    ctx.store.knowledge.rememberLocation({
      agentId: ctx.agent.id,
      position: regionCenter(already.region),
      kind: locationKindFor(type),
      confidence: 1,
      source: OBSERVED,
      label: type,
      discoveredAtDay: ctx.time.day,
      lastSeenAtTicks: ctx.time.totalTicks,
    });
    return ok({
      note: `the ${type} was already standing — I helped finish it`,
      agentPatch: { status: 'idle', activity: `worked on the ${type}` },
    });
  }

  const structureId = ctx.store.ids.next('struct') as StructureId;

  ctx.store.transaction(() => {
    const payload = {
      structureId,
      type,
      region: verified.value.region,
      builders: [ctx.agent.id],
      purpose: purposeOf(type),
    };
    appendAll(ctx, [{ type: 'structure_completed', actorId: ctx.agent.id, payload }]);

    // Fold it into the settlement's own record, and close whatever project
    // wanted it — otherwise the settlement never learns it has a shelter and
    // keeps asking for one.
    const context = { day: ctx.time.day, worldTicks: ctx.time.totalTicks };
    const structure = applyStructureCompleted(ctx.store, payload, context);
    completeProjectsFor(ctx.store, structure, context);

    // The agent now knows there is shelter here — which is what lets a later
    // "seek shelter" goal actually go somewhere.
    ctx.store.knowledge.rememberLocation({
      agentId: ctx.agent.id,
      position: regionCenter(verified.value.region),
      kind: locationKindFor(type),
      confidence: 1,
      source: OBSERVED,
      label: type,
      discoveredAtDay: ctx.time.day,
      lastSeenAtTicks: ctx.time.totalTicks,
    });
  });

  return ok({
    note: `the ${type} stands, verified from ${verified.value.verifiedSample} samples`,
    agentPatch: { status: 'idle', activity: `finished the ${type}` },
  });
}

// ── Economy and social ──────────────────────────────────────────────────────

async function depositResources(ctx: Ctx): Promise<Result<StepOutcome>> {
  const owner = agentOwner(ctx.agent.id);
  const balance = ctx.store.ledger.balance(owner);
  if (RESOURCE_KINDS.every((kind) => bundleGet(balance, kind) === 0)) {
    return ok({ note: 'nothing to deposit', skipped: true });
  }

  // Hand what was gathered to whichever project this agent is working on. This
  // is the step that turns several settlers gathering into one shelter rather
  // than five private hoards.
  const context = { day: ctx.time.day, worldTicks: ctx.time.totalTicks };
  const claims = ctx.store.projects.claimsBy(ctx.agent.id);

  for (const claim of claims) {
    const given = contribute(ctx.store, {
      projectId: claim.projectId,
      agentId: ctx.agent.id,
      time: context,
    });
    if (given.ok && !bundleIsEmpty(given.value.applied)) {
      return ok({
        note: `contributed ${formatBundle(given.value.applied)} to the settlement`,
        agentPatch: { activity: 'delivering supplies' },
      });
    }
  }

  return ok({ note: `holding ${formatBundle(balance)} with nowhere to put it`, skipped: true });
}

async function sendMessage(
  params: ActionParams['send_message'],
  ctx: Ctx,
): Promise<Result<StepOutcome>> {
  if (params.toAgentId === ctx.agent.id) {
    return ok({ note: 'no one to tell', skipped: true });
  }
  const recipient = ctx.store.agents.find(params.toAgentId);
  if (recipient === null) {
    return fail('TARGET_CHANGED', 'that person is not here', { retryable: false });
  }

  ctx.store.transaction(() => {
    const message = ctx.store.messages.send(ctx.agent.id, params.toAgentId, params.content, {
      day: ctx.time.day,
      worldTicks: ctx.time.totalTicks,
    });
    appendAll(ctx, [
      {
        type: 'message_sent',
        actorId: ctx.agent.id,
        payload: {
          messageId: message.id as never,
          fromAgentId: ctx.agent.id,
          toAgentId: params.toAgentId,
          content: params.content,
        },
      },
    ]);
  });

  return ok({
    note: `told ${recipient.name}`,
    agentPatch: { status: 'talking', activity: `speaking with ${recipient.name}` },
  });
}

async function rest(params: ActionParams['rest'], ctx: Ctx): Promise<Result<StepOutcome>> {
  // Resting is a state held over time, not an instantaneous act: the needs model
  // converts elapsed world time spent resting into recovered energy. So the step
  // stays in progress until the agent is actually rested — otherwise it completes
  // immediately, energy is still low, and the agent rests again in a loop.
  const energy = ctx.agent.needs.energy;
  if (energy >= params.untilEnergy) {
    return ok({
      note: `rested until recovered (energy ${Math.round(energy * 100)}%)`,
      agentPatch: { status: 'idle', activity: 'rested' },
    });
  }

  return ok({
    note: `resting (energy ${Math.round(energy * 100)}%)`,
    agentPatch: { status: 'resting', activity: 'resting' },
    incomplete: true,
  });
}

async function eat(params: ActionParams['eat'], ctx: Ctx): Promise<Result<StepOutcome>> {
  const owner = agentOwner(ctx.agent.id);
  const wanted = Math.max(1, Math.floor(params.amount));
  const available = ctx.store.ledger.quantity(owner, 'food');

  if (available <= 0) {
    return fail('INSUFFICIENT_RESOURCES', 'I have no food to eat', { retryable: false });
  }

  const eaten = Math.min(wanted, available);
  let restored = ctx.agent.needs.food;

  ctx.store.transaction(() => {
    const debited = ctx.store.ledger.debit(owner, { food: eaten });
    if (!debited.ok) return;
    restored = clamp01(ctx.agent.needs.food + eaten * 0.15);
    appendAll(ctx, [
      {
        type: 'resource_spent',
        actorId: ctx.agent.id,
        payload: { agentId: ctx.agent.id, resources: { food: eaten }, reason: 'eating' },
      },
    ]);
  });

  return ok({
    note: `ate ${eaten} food`,
    agentPatch: {
      needs: { ...ctx.agent.needs, food: restored },
      activity: 'eating',
    },
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function appendAll(ctx: Ctx, events: readonly NewEvent[]): void {
  if (events.length === 0) return;
  ctx.store.events.appendAll(events, { day: ctx.time.day, worldTicks: ctx.time.totalTicks });
}

function scaleBundle(bundle: ReturnType<typeof blueprintCost>, factor: number): typeof bundle {
  const out: typeof bundle = {};
  for (const kind of RESOURCE_KINDS) {
    const value = Math.floor(bundleGet(bundle, kind) * factor);
    if (value > 0) out[kind] = value;
  }
  return out;
}

/** Turn a terrain survey into the handful of places worth remembering. */
function classifyTerrain(
  cells: readonly SurveyCell[],
): { position: Position; kind: LocationKind; label: string }[] {
  if (cells.length === 0) return [];

  const out: { position: Position; kind: LocationKind; label: string }[] = [];
  const seen = new Set<string>();

  // Cluster on a coarse grid so a lake becomes one landmark, not four hundred.
  const note = (cell: SurveyCell, kind: LocationKind, label: string): void => {
    const key = `${kind}:${Math.floor(cell.x / 32)},${Math.floor(cell.z / 32)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ position: { x: cell.x, y: cell.y, z: cell.z }, kind, label });
  };

  const elevations = cells.map((cell) => cell.y);
  const highest = Math.max(...elevations);

  for (const cell of cells) {
    switch (cell.surface) {
      case 'water':
        note(cell, 'water', 'water');
        break;
      case 'wood':
      case 'vegetation':
        note(cell, 'forest', 'woodland');
        break;
      default:
        if (cell.y >= highest - 1) note(cell, 'high_ground', 'high ground');
        break;
    }
  }

  return out.slice(0, 4);
}

/**
 * Pick the flattest dry patch large enough for a footprint. Site selection is
 * arithmetic over a normalised survey, so it stays in the core rather than in
 * the adapter.
 */
function chooseFlattestSite(
  cells: readonly SurveyCell[],
  width: number,
  depth: number,
): Position | null {
  if (cells.length === 0) return null;

  const byKey = new Map<string, SurveyCell>();
  for (const cell of cells) byKey.set(`${cell.x},${cell.z}`, cell);

  let best: { position: Position; score: number } | null = null;

  for (const cell of cells) {
    if (cell.surface === 'water') continue;

    const heights: number[] = [];
    let dry = true;
    // Sample the footprint's corners and middle rather than every block.
    for (const dx of [0, Math.floor(width / 2), width]) {
      for (const dz of [0, Math.floor(depth / 2), depth]) {
        const neighbour = byKey.get(`${cell.x + dx},${cell.z + dz}`);
        if (neighbour === undefined) continue;
        if (neighbour.surface === 'water') dry = false;
        heights.push(neighbour.y);
      }
    }
    if (!dry || heights.length < 4) continue;

    const spread = Math.max(...heights) - Math.min(...heights);
    // Prefer flat, then slightly raised — a settlement on a rise reads well and
    // drains.
    const score = spread * 4 - cell.y * 0.1;
    if (best === null || score < best.score) {
      best = { position: { x: cell.x, y: cell.y + 1, z: cell.z }, score };
    }
  }

  return best?.position ?? null;
}

function locationKindFor(structureType: string): LocationKind {
  switch (structureType) {
    case 'shelter':
      return 'shelter';
    case 'storage':
      return 'storage';
    case 'farm':
      return 'farm';
    case 'mine':
      return 'mine';
    default:
      return 'landmark';
  }
}

function purposeOf(structureType: string): string {
  switch (structureType) {
    case 'shelter':
      return 'somewhere safe to sleep';
    case 'storage':
      return 'keeping the settlement’s supplies';
    case 'farm':
      return 'growing food';
    case 'mine':
      return 'reaching the stone and ore below';
    default:
      return 'the settlement';
  }
}
