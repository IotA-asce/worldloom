/**
 * Shared scaffolding for the chronicle tests.
 *
 * `SAMPLE_PAYLOADS` is exhaustive over `EventType` on purpose: it is what lets
 * the tests assert that *every* event the ledger can hold renders into a
 * sentence, and that every one of those sentences survives its own verifier. A
 * new event type therefore cannot be added without deciding how history
 * describes it (ADR-0009).
 */

import type { AgentId, GoalId, MessageId, PlanId, ProjectId, SettlementId, StructureId } from '../../src/core/ids.ts';
import type { Agent } from '../../src/agents/agent.ts';
import { NEUTRAL_PERSONALITY, NO_SKILLS, STARTING_NEEDS } from '../../src/agents/agent.ts';
import { region, type Position } from '../../src/core/world.ts';
import { nameBook, type NameBook } from '../../src/chronicle/renderers.ts';
import {
  DEFAULT_IMPORTANCE,
  type EventPayloads,
  type EventType,
  type WorldEvent,
} from '../../src/events/types.ts';

export const MIRA = 'agent_000001' as AgentId;
export const ARUN = 'agent_000002' as AgentId;
export const SETTLEMENT = 'stmt_000001' as SettlementId;
export const STRUCTURE = 'struct_000001' as StructureId;
export const PROJECT = 'proj_000001' as ProjectId;
export const GOAL = 'goal_000001' as GoalId;
export const PLAN = 'plan_000001' as PlanId;
export const MESSAGE = 'msg_000001' as MessageId;

export const SITE: Position = { x: 142, y: 68, z: -91 };

export function testNames(): NameBook {
  return nameBook([
    { id: MIRA, name: 'Mira' },
    { id: ARUN, name: 'Arun' },
  ]);
}

export function testAgent(id: AgentId, name: string, role = 'Builder'): Agent {
  return {
    id,
    name,
    role,
    personality: NEUTRAL_PERSONALITY,
    skills: NO_SKILLS,
    needs: STARTING_NEEDS,
    position: SITE,
    health: 1,
    status: 'idle',
    phase: 'observe',
    currentGoalId: null,
    lastTickAt: 0,
    activity: 'newly arrived',
    spawnedAtDay: 0,
  };
}

export interface EventOverrides {
  readonly day?: number;
  readonly seq?: number;
  readonly actorId?: AgentId | null;
  readonly importance?: number;
}

/**
 * A source of stored-looking events with stable ids, so a failure names the
 * event it happened on.
 */
export function eventMaker(startSeq = 1): <T extends EventType>(
  type: T,
  payload: EventPayloads[T],
  overrides?: EventOverrides,
) => WorldEvent<T> {
  let next = startSeq;
  return <T extends EventType>(
    type: T,
    payload: EventPayloads[T],
    overrides: EventOverrides = {},
  ): WorldEvent<T> => {
    const seq = overrides.seq ?? next++;
    return {
      id: `evt_${String(seq).padStart(6, '0')}`,
      seq,
      type,
      day: overrides.day ?? 1,
      worldTicks: seq * 100,
      actorId: overrides.actorId ?? null,
      payload,
      importance: overrides.importance ?? DEFAULT_IMPORTANCE[type],
      recordedAt: 0,
    };
  };
}

/** One representative payload per event type. Exhaustive by construction. */
export const SAMPLE_PAYLOADS: { readonly [T in EventType]: EventPayloads[T] } = {
  simulation_started: { scenario: 'first-settlement', agents: 2, seed: 42 },
  simulation_resumed: { scenario: 'first-settlement', fromDay: 1 },
  day_began: { day: 2 },
  settlement_founded: {
    settlementId: SETTLEMENT,
    name: 'Aurelian Reach',
    center: SITE,
    objective: 'Establish a self-sustaining settlement',
  },
  agent_spawned: { agentId: MIRA, name: 'Mira', role: 'Builder', at: SITE },

  location_discovered: { agentId: MIRA, at: { x: 120, y: 70, z: -80 }, kind: 'landmark', confidence: 0.6 },
  resource_discovered: { agentId: ARUN, resource: 'iron', at: { x: 130, y: 40, z: -70 }, estimatedQuantity: 30 },
  knowledge_shared: {
    fromAgentId: ARUN,
    toAgentId: MIRA,
    subject: 'the iron seam',
    detail: 'it runs below the eastern ridge',
  },

  resource_collected: {
    agentId: MIRA,
    resource: 'wood',
    quantity: 24,
    from: region({ x: 100, y: 64, z: -100 }, { x: 110, y: 70, z: -90 }),
    verifiedSample: 24,
  },
  resource_spent: { agentId: MIRA, resources: { wood: 20 }, reason: 'building the shelter' },
  resource_withdrawn: {
    agentId: MIRA,
    settlementId: SETTLEMENT,
    resources: { wood: 12 },
    reason: 'building the shelter',
  },
  resource_transferred: {
    fromAgentId: ARUN,
    toAgentId: MIRA,
    resources: { stone: 8 },
    reason: 'she had run short',
  },
  resource_deposited: { agentId: ARUN, settlementId: SETTLEMENT, resources: { food: 6 } },

  goal_created: {
    agentId: MIRA,
    goalId: GOAL,
    kind: 'build_structure',
    reason: 'the settlement still has no permanent shelter',
    priority: 0.85,
  },
  goal_completed: { agentId: MIRA, goalId: GOAL, kind: 'build_structure' },
  goal_failed: { agentId: ARUN, goalId: GOAL, kind: 'gather_resource', reason: 'the seam was empty' },
  goal_abandoned: { agentId: ARUN, goalId: GOAL, kind: 'explore_region', reason: 'night was closing in' },
  goal_blocked: { agentId: MIRA, goalId: GOAL, kind: 'build_structure', reason: 'the site was reserved' },
  plan_created: { agentId: MIRA, goalId: GOAL, planId: PLAN, steps: 7 },
  plan_revised: { agentId: MIRA, planId: PLAN, reason: 'the first route was impassable', steps: 9 },
  action_failed: {
    agentId: ARUN,
    action: 'harvest_resource',
    failureKind: 'RESOURCE_UNAVAILABLE',
    detail: 'nothing was left to cut',
  },

  agent_moved: { agentId: MIRA, from: SITE, to: { x: 150, y: 68, z: -85 } },
  agent_injured: { agentId: ARUN, cause: 'a fall', health: 0.55 },
  agent_died: { agentId: ARUN, cause: 'exposure' },
  need_critical: { agentId: MIRA, need: 'food', value: 0.05 },
  agent_reflected: {
    agentId: MIRA,
    belief: 'the ridge to the east is where the stone is',
    fromMemories: 12,
  },

  structure_started: {
    agentId: MIRA,
    structureId: STRUCTURE,
    type: 'shelter',
    region: region(SITE, { x: 146, y: 71, z: -87 }),
  },
  structure_completed: {
    structureId: STRUCTURE,
    type: 'storage',
    region: region(SITE, { x: 146, y: 71, z: -85 }),
    builders: [MIRA],
    purpose: 'somewhere to keep what the settlement gathers',
  },
  structure_damaged: { structureId: STRUCTURE, type: 'shelter', detail: 'a wall had fallen in' },

  project_created: {
    settlementId: SETTLEMENT,
    projectId: PROJECT,
    kind: 'build_storage',
    requirements: { stone: 60 },
  },
  project_claimed: { projectId: PROJECT, agentId: ARUN, role: 'gathering' },
  project_completed: { projectId: PROJECT, kind: 'build_storage' },
  help_requested: { agentId: MIRA, need: 'stone', detail: 'the walls are twenty short' },

  message_sent: {
    messageId: MESSAGE,
    fromAgentId: MIRA,
    toAgentId: ARUN,
    content: 'I need stone for the walls.',
  },
  message_received: { messageId: MESSAGE, agentId: ARUN, interpretation: 'she wants me to bring stone' },
  relationship_changed: {
    agentId: MIRA,
    otherAgentId: ARUN,
    trustDelta: 0.1,
    affinityDelta: 0.05,
    reason: 'he brought the stone she asked for',
  },

  chronicle_entry_written: { day: 1, title: 'Day 1: the founding', fromEvents: 4 },
};

export const ALL_EVENT_TYPES: readonly EventType[] = Object.keys(SAMPLE_PAYLOADS) as EventType[];

/** Every event type once, all on the same day, in a stable order. */
export function oneOfEverything(day = 1): WorldEvent[] {
  const event = eventMaker();
  return ALL_EVENT_TYPES.map((type) =>
    event(type, SAMPLE_PAYLOADS[type], { day, actorId: MIRA }),
  );
}
