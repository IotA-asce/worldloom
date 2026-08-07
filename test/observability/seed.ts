/**
 * A small hand-built world for the observability tests.
 *
 * Hand-built rather than simulated on purpose: these tests assert on exact
 * numbers, exact groupings and exact isolation, and a real run's numbers move
 * whenever the planner does. The criterion test runs the real simulation instead
 * — the two together check that the views are correct *and* that they work on
 * data the simulation actually produces.
 *
 * Two settlers: Mira, a builder mid-plan on a shelter after abandoning a farm;
 * Arun, a scout gathering wood. Arun's private rows carry a distinctive marker
 * so a leak into Mira's view is visible rather than inferred.
 *
 * The wire-safety assertions live here too, since every view test needs them.
 */

import assert from 'node:assert/strict';

import { NEUTRAL_PERSONALITY, NO_SKILLS, type Agent } from '../../src/agents/agent.ts';
import type { Settlement } from '../../src/civilization/types.ts';
import { sequentialIdFactory, type AgentId, type EventId, type MemoryId } from '../../src/core/ids.ts';
import { position, region, type Position } from '../../src/core/world.ts';
import type { Goal } from '../../src/goals/goal.ts';
import { makeStep, type Plan } from '../../src/goals/plan.ts';
import { OBSERVED, toldBy } from '../../src/memory/types.ts';
import { agentOwner, settlementOwner } from '../../src/persistence/repositories/ledger.ts';
import { Store } from '../../src/persistence/store.ts';

/** A string that appears only in Arun's private rows. */
export const ARUN_PRIVATE_MARKER = 'ARUN-ONLY-BELIEF';

/**
 * A view has to survive the wire: a dashboard receives it as JSON, so anything
 * that does not round-trip through `JSON.stringify` is a field the dashboard
 * will never see. `undefined` is the usual culprit — it vanishes silently, which
 * is why it is asserted against separately rather than left to the comparison.
 */
export function assertJsonSafe(value: unknown, what: string): void {
  assertNoUndefined(value, what);
  const roundTripped: unknown = JSON.parse(JSON.stringify(value));
  assert.deepEqual(roundTripped, value, `${what} does not survive a JSON round trip`);
}

function assertNoUndefined(value: unknown, path: string): void {
  assert.notEqual(value, undefined, `${path} is undefined, which JSON would drop`);
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      assertNoUndefined(entry, `${path}[${String(index)}]`);
    });
    return;
  }
  assert.ok(
    !(value instanceof Map) && !(value instanceof Set),
    `${path} is a Map or Set, which JSON renders as {}`,
  );
  for (const [key, entry] of Object.entries(value)) {
    assertNoUndefined(entry, `${path}.${key}`);
  }
}

export interface SeededWorld {
  readonly store: Store;
  readonly settlement: Settlement;
  readonly mira: Agent;
  readonly arun: Agent;
  /** Mira's live shelter goal. */
  readonly shelterGoal: Goal;
  /** The farm she gave up on — the "why did Mira abandon it?" question. */
  readonly farmGoal: Goal;
  readonly shelterPlan: Plan;
  /** The event that recorded the abandonment. */
  readonly abandonedEventId: EventId;
  /** The goal-selection decision that put her on the shelter. */
  readonly shelterDecisionId: string;
  /** The decision that gave the farm up, linked explicitly to its event. */
  readonly abandonDecisionId: string;
  readonly close: () => void;
}

function agentAt(
  id: AgentId,
  name: string,
  role: string,
  at: Position,
  overrides: Partial<Agent> = {},
): Agent {
  return {
    id,
    name,
    role,
    personality: NEUTRAL_PERSONALITY,
    skills: NO_SKILLS,
    needs: { food: 0.6, safety: 0.5, shelter: 0.15, energy: 0.7, social: 0.4 },
    position: at,
    health: 1,
    status: 'building',
    phase: 'act',
    currentGoalId: null,
    lastTickAt: 26_000,
    activity: `${name} is at work`,
    spawnedAtDay: 0,
    ...overrides,
  };
}

/** One agent in an otherwise bare store, for tests that need only a subject. */
export function insertAgent(store: Store, name: string, role = 'Settler'): Agent {
  const agent = agentAt(store.ids.next('agent'), name, role, position(0, 64, 0), {
    status: 'idle',
    phase: 'observe',
    activity: '',
    lastTickAt: 0,
  });
  store.agents.insert(agent);
  return agent;
}

export function seedWorld(): SeededWorld {
  const store = Store.openMemory(sequentialIdFactory());

  store.simulation.initialise('first-settlement', 42, 1_700_000_000_000);
  // Two simulated days: a full day 0, then partway into day 1.
  store.simulation.advanceClock(23_000, 'clear');
  store.simulation.advanceClock(6_000, 'clear');
  const time = store.simulation.currentTime();

  const settlement = store.settlements.upsert({
    id: store.ids.next('stmt'),
    name: 'Riverbend',
    objective: 'survive the first winter',
    foundingDay: 0,
    center: position(0, 64, 0),
    status: 'active',
  });

  const mira = agentAt(store.ids.next('agent'), 'Mira', 'Builder', position(4, 64, -2));
  const arun = agentAt(store.ids.next('agent'), 'Arun', 'Scout', position(-18, 66, 12), {
    status: 'gathering',
    phase: 'observe',
    activity: 'Arun is felling trees on the ridge',
    needs: { food: 0.9, safety: 0.8, shelter: 0.5, energy: 0.3, social: 0.7 },
  });
  store.agents.insert(mira);
  store.agents.insert(arun);

  // ── Mira: a goal she abandoned, and the one she is on now ─────────────────
  const farmGoal: Goal = {
    id: store.ids.next('goal'),
    agentId: mira.id,
    kind: 'build_structure',
    params: { structureType: 'farm', blueprint: 'farm_plot' },
    state: 'abandoned',
    priority: 0.4,
    reason: 'the settlement needs food it does not have to walk for',
    parentGoalId: null,
    createdAtDay: 0,
    createdAtTicks: 4_000,
    resolvedAtTicks: 12_000,
    outcome: 'no soil within reach of the settlement',
  };
  store.goals.insert(farmGoal);

  const shelterGoal: Goal = {
    id: store.ids.next('goal'),
    agentId: mira.id,
    kind: 'build_structure',
    params: { structureType: 'shelter', blueprint: 'day_one_shelter' },
    state: 'active',
    priority: 0.85,
    reason: 'nightfall is close and nobody has anywhere to sleep',
    parentGoalId: null,
    createdAtDay: 1,
    createdAtTicks: 25_000,
    resolvedAtTicks: null,
    outcome: null,
  };
  store.goals.insert(shelterGoal);
  store.agents.update({ ...mira, currentGoalId: shelterGoal.id });

  const shelterPlan: Plan = {
    id: store.ids.next('plan'),
    goalId: shelterGoal.id,
    agentId: mira.id,
    steps: [
      { ...makeStep(0, 'select_site', { blueprint: 'day_one_shelter', searchRadius: 24 }), status: 'completed', attempts: 1, note: 'flat ground east of the river' },
      {
        ...makeStep(1, 'harvest_resource', { resource: 'wood', quantity: 24 }),
        status: 'failed',
        attempts: 2,
        failure: {
          kind: 'RESOURCE_UNAVAILABLE',
          detail: 'the stand of trees at (-12, 66, 8) is gone',
          retryable: false,
        },
      },
      { ...makeStep(2, 'place_blueprint', { blueprint: 'day_one_shelter', origin: position(6, 64, -4) }), status: 'active', attempts: 1 },
      makeStep(3, 'verify_structure', { blueprint: 'day_one_shelter', origin: position(6, 64, -4) }),
    ],
    currentStep: 2,
    state: 'active',
    createdAtTicks: 25_100,
    revision: 1,
  };
  store.plans.insert(shelterPlan);

  // ── Arun: a live gathering goal ───────────────────────────────────────────
  const gatherGoal: Goal = {
    id: store.ids.next('goal'),
    agentId: arun.id,
    kind: 'gather_resource',
    params: { resource: 'wood', quantity: 40 },
    state: 'active',
    priority: 0.6,
    reason: 'the shelter needs timber and Mira has none',
    parentGoalId: null,
    createdAtDay: 1,
    createdAtTicks: 25_500,
    resolvedAtTicks: null,
    outcome: null,
  };
  store.goals.insert(gatherGoal);
  store.plans.insert({
    id: store.ids.next('plan'),
    goalId: gatherGoal.id,
    agentId: arun.id,
    steps: [
      { ...makeStep(0, 'travel_to', { target: { kind: 'resource', resource: 'wood' } }), status: 'completed', attempts: 1 },
      { ...makeStep(1, 'harvest_resource', { resource: 'wood', quantity: 40 }), status: 'active', attempts: 1 },
    ],
    currentStep: 1,
    state: 'active',
    createdAtTicks: 25_600,
    revision: 0,
  });
  store.agents.update({ ...store.agents.get(arun.id), currentGoalId: gatherGoal.id });

  // ── The ledger ────────────────────────────────────────────────────────────
  store.ledger.credit(agentOwner(mira.id), { stone: 12, food: 4 });
  store.ledger.credit(agentOwner(arun.id), { wood: 18, food: 2 });
  store.ledger.credit(settlementOwner(settlement.id), { wood: 30, stone: 6 });

  // ── Public facts ──────────────────────────────────────────────────────────
  const storehouse = store.ids.next('struct');
  store.structures.insert({
    id: storehouse,
    settlementId: settlement.id,
    type: 'storage',
    blueprint: 'storehouse',
    region: region(position(0, 64, 0), position(4, 67, 4)),
    builders: [mira.id],
    purpose: 'keep the settlement stock out of the weather',
    state: 'complete',
    createdAtDay: 0,
    createdAtTicks: 8_000,
    verifiedAtTicks: 8_400,
  });

  const shelterProject = store.ids.next('proj');
  store.projects.insert({
    id: shelterProject,
    settlementId: settlement.id,
    kind: 'build',
    blueprint: 'day_one_shelter',
    requirements: { wood: 40, stone: 12 },
    site: position(6, 64, -4),
    state: 'active',
    priority: 0.9,
    reason: 'five settlers and nowhere to sleep',
    createdAtDay: 1,
    createdAtTicks: 24_800,
    completedAtTicks: null,
    structureId: null,
  });
  store.projects.claim(shelterProject, mira.id, 'building', 25_000);
  store.projects.claim(shelterProject, arun.id, 'gathering', 25_500);

  // ── The ledger of events ──────────────────────────────────────────────────
  const day0 = { day: 0, worldTicks: 1_000 };
  const day1 = { day: 1, worldTicks: 25_000 };

  store.events.append(
    { type: 'settlement_founded', actorId: null, payload: { settlementId: settlement.id, name: settlement.name, center: settlement.center, objective: settlement.objective } },
    day0,
    1_700_000_001_000,
  );
  for (const agent of [mira, arun]) {
    store.events.append(
      { type: 'agent_spawned', actorId: agent.id, payload: { agentId: agent.id, name: agent.name, role: agent.role, at: agent.position } },
      day0,
      1_700_000_002_000,
    );
  }

  const abandoned = store.events.append(
    {
      type: 'goal_abandoned',
      actorId: mira.id,
      payload: { agentId: mira.id, goalId: farmGoal.id, kind: 'build_structure', reason: 'no soil within reach of the settlement' },
    },
    { day: 0, worldTicks: 12_000 },
    1_700_000_003_000,
  );

  store.events.append(
    {
      type: 'goal_created',
      actorId: mira.id,
      payload: { agentId: mira.id, goalId: shelterGoal.id, kind: 'build_structure', reason: shelterGoal.reason, priority: shelterGoal.priority },
    },
    day1,
    1_700_000_004_000,
  );

  const harvestFailed = store.events.append(
    {
      type: 'action_failed',
      actorId: mira.id,
      payload: { agentId: mira.id, action: 'harvest_resource', failureKind: 'RESOURCE_UNAVAILABLE', detail: 'the stand of trees at (-12, 66, 8) is gone' },
    },
    { day: 1, worldTicks: 25_200 },
    1_700_000_005_000,
  );
  store.events.append(
    {
      type: 'action_failed',
      actorId: mira.id,
      payload: { agentId: mira.id, action: 'harvest_resource', failureKind: 'RESOURCE_UNAVAILABLE', detail: 'nothing left in the eastern copse' },
    },
    { day: 1, worldTicks: 25_300 },
    1_700_000_006_000,
  );
  store.events.append(
    {
      type: 'action_failed',
      actorId: arun.id,
      payload: { agentId: arun.id, action: 'travel_to', failureKind: 'PATH_BLOCKED', detail: 'the ravine has no crossing within 30 blocks' },
    },
    { day: 1, worldTicks: 25_700 },
    1_700_000_007_000,
  );
  store.events.append(
    {
      type: 'goal_failed',
      actorId: arun.id,
      payload: { agentId: arun.id, goalId: gatherGoal.id, kind: 'gather_resource', reason: 'three plans, no route to the timber' },
    },
    { day: 1, worldTicks: 25_800 },
    1_700_000_008_000,
  );
  const collected = store.events.append(
    {
      type: 'resource_collected',
      actorId: arun.id,
      payload: { agentId: arun.id, resource: 'wood', quantity: 18, from: region(position(-20, 64, 10), position(-16, 70, 14)), verifiedSample: 18 },
    },
    { day: 1, worldTicks: 25_900 },
    1_700_000_009_000,
  );
  store.events.append(
    {
      type: 'structure_completed',
      actorId: mira.id,
      payload: { structureId: storehouse, type: 'storage', region: region(position(0, 64, 0), position(4, 67, 4)), builders: [mira.id], purpose: 'keep the settlement stock out of the weather' },
    },
    { day: 0, worldTicks: 8_400 },
    1_700_000_010_000,
  );

  // ── Memories ──────────────────────────────────────────────────────────────
  const miraMemories: MemoryId[] = [];
  miraMemories.push(
    store.memories.insert(
      {
        agentId: mira.id,
        type: 'episodic',
        content: 'I gave up on the farm: there is no soil within reach of Riverbend.',
        importance: 0.7,
        source: OBSERVED,
        relatedEntities: [farmGoal.id],
        tags: ['farm', 'soil'],
        eventId: abandoned.id as EventId,
      },
      { day: 0, worldTicks: 12_050 },
    ).id,
  );
  miraMemories.push(
    store.memories.insert(
      {
        agentId: mira.id,
        type: 'semantic',
        content: 'The ground east of the river is flat enough to build on.',
        importance: 0.6,
        source: OBSERVED,
        tags: ['site'],
      },
      { day: 1, worldTicks: 25_050 },
    ).id,
  );
  store.memories.insert(
    {
      agentId: mira.id,
      type: 'episodic',
      content: 'The trees I counted on had already been felled.',
      importance: 0.5,
      source: OBSERVED,
      eventId: harvestFailed.id as EventId,
    },
    { day: 1, worldTicks: 25_250 },
  );
  store.memories.insert(
    {
      agentId: mira.id,
      type: 'relationship',
      content: 'Arun said he would bring timber, and he did.',
      importance: 0.5,
      source: toldBy(arun.id),
      relatedEntities: [arun.id],
    },
    { day: 1, worldTicks: 25_950 },
  );

  store.memories.insert(
    {
      agentId: arun.id,
      type: 'episodic',
      content: `${ARUN_PRIVATE_MARKER}: the ridge north of camp still has standing timber.`,
      importance: 0.8,
      source: OBSERVED,
      tags: ['wood', 'ridge'],
      eventId: collected.id as EventId,
    },
    { day: 1, worldTicks: 25_920 },
  );
  store.memories.insert(
    {
      agentId: arun.id,
      type: 'semantic',
      content: `${ARUN_PRIVATE_MARKER}: the ravine cannot be crossed anywhere I have looked.`,
      importance: 0.6,
      source: OBSERVED,
    },
    { day: 1, worldTicks: 25_750 },
  );

  // ── Knowledge and relationships ───────────────────────────────────────────
  store.knowledge.rememberLocation({
    agentId: mira.id,
    position: position(6, 64, -4),
    kind: 'build_site',
    confidence: 0.9,
    source: OBSERVED,
    label: 'flat ground east of the river',
    discoveredAtDay: 1,
    lastSeenAtTicks: 25_050,
  });
  store.knowledge.rememberResource({
    agentId: mira.id,
    resource: 'stone',
    position: position(10, 60, -8),
    estimatedQuantity: 40,
    confidence: 0.8,
    source: OBSERVED,
    discoveredAtDay: 0,
    lastSeenAtTicks: 9_000,
  });
  store.knowledge.rememberLocation({
    agentId: arun.id,
    position: position(-24, 70, 18),
    kind: 'forest',
    confidence: 0.95,
    source: OBSERVED,
    label: `${ARUN_PRIVATE_MARKER} northern ridge`,
    discoveredAtDay: 1,
    lastSeenAtTicks: 25_900,
  });
  store.knowledge.rememberResource({
    agentId: arun.id,
    resource: 'wood',
    position: position(-24, 70, 18),
    estimatedQuantity: 120,
    confidence: 0.95,
    source: OBSERVED,
    discoveredAtDay: 1,
    lastSeenAtTicks: 25_900,
  });

  store.knowledge.adjustRelationship(
    mira.id,
    arun.id,
    { trust: 0.6, affinity: 0.3, familiarity: 0.5, reason: 'brought the timber he promised', eventId: collected.id as EventId },
    25_950,
  );
  store.knowledge.adjustRelationship(
    arun.id,
    mira.id,
    { trust: 0.2, affinity: 0.4, familiarity: 0.5, reason: 'kept working while I was away' },
    25_960,
  );

  store.messages.send(arun.id, mira.id, 'Eighteen logs on the way, the ridge still has more.', {
    day: 1,
    worldTicks: 25_930,
  });

  // ── The audit trail ───────────────────────────────────────────────────────
  // A rule-answered decision, a model-answered one, and one where the model was
  // asked and the rule answered instead — so the reliance report has all three.
  const abandonDecision: { id: string } = store.decisions.record({
    agentId: mira.id,
    category: 'replanning',
    worldTicks: 11_900,
    day: 0,
    observation: { position: mira.position, knownSoilSites: 0, attempts: 3 },
    memoryIds: [],
    prompt: 'Your goal: build farm. The step select_site failed: [RESOURCE_UNAVAILABLE] no soil.',
    response: '{"action":"abandon","reason":"no soil within reach of the settlement"}',
    model: 'claude-opus-5',
    chosenAction: 'abandon: no soil within reach of the settlement',
    eventId: abandoned.id as EventId,
    llmCallId: null,
  });

  const shelterDecision = store.decisions.record({
    agentId: mira.id,
    category: 'goal_selection',
    worldTicks: 25_000,
    day: 1,
    observation: {
      position: mira.position,
      needs: { shelter: 0.15, food: 0.6 },
      phase: time.phase,
      sheltered: false,
      knownResources: 1,
    },
    memoryIds: miraMemories,
    prompt: 'You are Mira. Nightfall is close. Choose a goal.',
    response: '{"goal":"build_structure","reason":"nightfall is close and nobody has anywhere to sleep"}',
    model: 'claude-opus-5',
    chosenAction: `build_structure: ${shelterGoal.reason}`,
    eventId: null,
    llmCallId: null,
  });

  store.decisions.record({
    agentId: arun.id,
    category: 'goal_selection',
    worldTicks: 25_500,
    day: 1,
    observation: { position: arun.position, needs: { energy: 0.3 }, sheltered: false },
    memoryIds: [],
    prompt: 'You are Arun. Choose a goal.',
    // No response: the model was asked and the rule answered — a degraded decision.
    response: null,
    model: 'claude-opus-5',
    chosenAction: `gather_resource: ${gatherGoal.reason}`,
    eventId: null,
    llmCallId: null,
  });

  store.decisions.record({
    agentId: arun.id,
    category: 'replanning',
    worldTicks: 25_800,
    day: 1,
    observation: { failure: 'PATH_BLOCKED', attempts: 3 },
    memoryIds: [],
    prompt: 'Your goal: gather wood. The step travel_to failed.',
    response: null,
    model: 'heuristic',
    chosenAction: 'abandon: after 3 attempts this is not achievable from here',
    eventId: null,
    llmCallId: null,
  });

  // ── Metered model calls ───────────────────────────────────────────────────
  store.llmCalls.record({ agentId: null, category: 'replanning', provider: 'anthropic', model: 'claude-opus-5', inputTokens: 1_200, outputTokens: 180, costUsd: 0.0105, durationMs: 2_400, day: 0, ok: true, error: null, createdAt: 1_700_000_003_100 });
  store.llmCalls.record({ agentId: null, category: 'goal_selection', provider: 'anthropic', model: 'claude-opus-5', inputTokens: 1_600, outputTokens: 220, costUsd: 0.0135, durationMs: 2_900, day: 1, ok: true, error: null, createdAt: 1_700_000_004_100 });
  store.llmCalls.record({ agentId: null, category: 'goal_selection', provider: 'anthropic', model: 'claude-opus-5', inputTokens: 1_500, outputTokens: 0, costUsd: 0.0075, durationMs: 1_100, day: 1, ok: false, error: 'the response did not validate against the schema', createdAt: 1_700_000_004_200 });
  store.llmCalls.record({ agentId: mira.id, category: 'reflection', provider: 'anthropic', model: 'claude-haiku-4-5', inputTokens: 900, outputTokens: 120, costUsd: 0.0015, durationMs: 800, day: 1, ok: true, error: null, createdAt: 1_700_000_006_100 });

  return {
    store,
    settlement,
    mira: store.agents.get(mira.id),
    arun: store.agents.get(arun.id),
    shelterGoal,
    farmGoal,
    shelterPlan,
    abandonedEventId: abandoned.id as EventId,
    shelterDecisionId: shelterDecision.id,
    abandonDecisionId: abandonDecision.id,
    close: () => {
      store.close();
    },
  };
}
