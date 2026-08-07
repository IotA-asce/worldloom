/**
 * The event ledger's vocabulary.
 *
 * Events are the authoritative history of a simulation (requirement 21). Two
 * rules follow from that and shape everything here:
 *
 *  - Events are append-only. There is no update or delete path.
 *  - Anything the chronicle may claim must exist as an event first
 *    (ADR-0009). If a behaviour has no event, it did not happen.
 *
 * Payloads are typed per event so a malformed event is a compile error rather
 * than a surprise in the chronicle six days into a run.
 */

import type {
  AgentId,
  GoalId,
  MessageId,
  PlanId,
  ProjectId,
  SettlementId,
  StructureId,
} from '../core/ids.ts';
import type { Position, Region, ResourceBundle, ResourceKind } from '../core/world.ts';

/** How much a fact matters, 0..1. Drives chronicle selection and memory decay. */
export type Importance = number;

export interface EventPayloads {
  // ── Lifecycle ─────────────────────────────────────────────────────────────
  simulation_started: { scenario: string; agents: number; seed: number };
  simulation_resumed: { scenario: string; fromDay: number };
  day_began: { day: number };
  settlement_founded: { settlementId: SettlementId; name: string; center: Position; objective: string };
  agent_spawned: { agentId: AgentId; name: string; role: string; at: Position };

  // ── Discovery and knowledge ───────────────────────────────────────────────
  location_discovered: { agentId: AgentId; at: Position; kind: string; confidence: number };
  resource_discovered: { agentId: AgentId; resource: ResourceKind; at: Position; estimatedQuantity: number };
  /** Knowledge crossing from one agent to another — requirement 35's criterion. */
  knowledge_shared: {
    fromAgentId: AgentId;
    toAgentId: AgentId;
    subject: string;
    detail: string;
  };

  // ── Resources ─────────────────────────────────────────────────────────────
  /** Credited only for blocks confirmed removed from the world (ADR-0004). */
  resource_collected: {
    agentId: AgentId;
    resource: ResourceKind;
    quantity: number;
    from: Region;
    verifiedSample: number;
  };
  resource_spent: { agentId: AgentId; resources: ResourceBundle; reason: string };
  resource_transferred: {
    fromAgentId: AgentId;
    toAgentId: AgentId;
    resources: ResourceBundle;
    reason: string;
  };
  resource_deposited: { agentId: AgentId; settlementId: SettlementId; resources: ResourceBundle };
  /** The other direction: a builder drawing shared materials out of the store.
   *  Recorded because every ledger mutation must be explained by an event
   *  (ADR-0004) — otherwise the settlement's economy stops reconciling. */
  resource_withdrawn: {
    agentId: AgentId;
    settlementId: SettlementId;
    resources: ResourceBundle;
    reason: string;
  };

  // ── Goals and plans ───────────────────────────────────────────────────────
  goal_created: { agentId: AgentId; goalId: GoalId; kind: string; reason: string; priority: number };
  goal_completed: { agentId: AgentId; goalId: GoalId; kind: string };
  goal_failed: { agentId: AgentId; goalId: GoalId; kind: string; reason: string };
  goal_abandoned: { agentId: AgentId; goalId: GoalId; kind: string; reason: string };
  goal_blocked: { agentId: AgentId; goalId: GoalId; kind: string; reason: string };
  plan_created: { agentId: AgentId; goalId: GoalId; planId: PlanId; steps: number };
  plan_revised: { agentId: AgentId; planId: PlanId; reason: string; steps: number };
  action_failed: { agentId: AgentId; action: string; failureKind: string; detail: string };

  // ── Movement and state ────────────────────────────────────────────────────
  agent_moved: { agentId: AgentId; from: Position; to: Position };
  agent_injured: { agentId: AgentId; cause: string; health: number };
  agent_died: { agentId: AgentId; cause: string };
  need_critical: { agentId: AgentId; need: string; value: number };
  agent_reflected: { agentId: AgentId; belief: string; fromMemories: number };

  // ── Construction ──────────────────────────────────────────────────────────
  structure_started: { agentId: AgentId; structureId: StructureId; type: string; region: Region };
  structure_completed: {
    structureId: StructureId;
    type: string;
    region: Region;
    builders: readonly AgentId[];
    purpose: string;
  };
  structure_damaged: { structureId: StructureId; type: string; detail: string };

  // ── Coordination ──────────────────────────────────────────────────────────
  project_created: { settlementId: SettlementId; projectId: ProjectId; kind: string; requirements: ResourceBundle };
  project_claimed: { projectId: ProjectId; agentId: AgentId; role: string };
  project_completed: { projectId: ProjectId; kind: string };
  help_requested: { agentId: AgentId; need: string; detail: string };

  // ── Social ────────────────────────────────────────────────────────────────
  message_sent: { messageId: MessageId; fromAgentId: AgentId; toAgentId: AgentId; content: string };
  message_received: { messageId: MessageId; agentId: AgentId; interpretation: string };
  relationship_changed: {
    agentId: AgentId;
    otherAgentId: AgentId;
    trustDelta: number;
    affinityDelta: number;
    reason: string;
  };

  // ── Narrative ─────────────────────────────────────────────────────────────
  chronicle_entry_written: { day: number; title: string; fromEvents: number };
}

export type EventType = keyof EventPayloads;

/** A recorded event. `seq` is assigned by the store and defines total order. */
export interface WorldEvent<T extends EventType = EventType> {
  readonly id: string;
  readonly seq: number;
  readonly type: T;
  /** Minecraft day the event occurred on (ADR-0011). */
  readonly day: number;
  /** Monotonic world tick, for ordering within a day. */
  readonly worldTicks: number;
  /** The agent responsible, when there is one. */
  readonly actorId: AgentId | null;
  readonly payload: EventPayloads[T];
  readonly importance: Importance;
  /** Wall-clock insert time, for debugging real-time behaviour. */
  readonly recordedAt: number;
}

/** An event before the store assigns it a sequence and id. */
export interface NewEvent<T extends EventType = EventType> {
  readonly type: T;
  readonly actorId: AgentId | null;
  readonly payload: EventPayloads[T];
  /** Overrides the default importance for the type. */
  readonly importance?: Importance;
}

/**
 * Default importance per type.
 *
 * These numbers do real work: they decide what reaches the chronicle and how
 * slowly a memory decays. The scale is deliberately coarse —
 * 0.9+ era-defining, 0.7+ notable, 0.4+ worth remembering, below that routine.
 */
export const DEFAULT_IMPORTANCE: Readonly<Record<EventType, Importance>> = {
  simulation_started: 1.0,
  simulation_resumed: 0.3,
  day_began: 0.2,
  settlement_founded: 1.0,
  agent_spawned: 0.9,

  location_discovered: 0.4,
  // Finding another berry bush is not history. A *first* strike is, and the
  // executor raises the importance of those individually — see actions.ts.
  resource_discovered: 0.35,
  knowledge_shared: 0.6,

  resource_collected: 0.3,
  resource_spent: 0.2,
  resource_transferred: 0.6,
  resource_deposited: 0.3,
  resource_withdrawn: 0.3,

  goal_created: 0.4,
  goal_completed: 0.6,
  goal_failed: 0.7,
  goal_abandoned: 0.6,
  goal_blocked: 0.5,
  plan_created: 0.3,
  plan_revised: 0.5,
  action_failed: 0.4,

  agent_moved: 0.1,
  agent_injured: 0.8,
  agent_died: 1.0,
  need_critical: 0.7,
  agent_reflected: 0.5,

  structure_started: 0.6,
  structure_completed: 0.9,
  structure_damaged: 0.7,

  project_created: 0.6,
  project_claimed: 0.4,
  project_completed: 0.8,
  help_requested: 0.5,

  message_sent: 0.3,
  message_received: 0.2,
  relationship_changed: 0.6,

  chronicle_entry_written: 0.1,
};

/**
 * Types that always reach the chronicle regardless of the importance threshold
 * (ADR-0009 step 1). A settlement's founding is never "routine" even on a busy
 * day that raises the bar.
 *
 * `resource_discovered` is deliberately *not* here. Five settlers foraging
 * rediscover food constantly, and forcing every find into history buried the
 * shelter being built under forty berry bushes. Importance decides instead, and
 * a genuine first strike is given a high one where it happens.
 */
export const ALWAYS_NOTABLE: ReadonlySet<EventType> = new Set<EventType>([
  'settlement_founded',
  'agent_spawned',
  'agent_died',
  'structure_completed',
  'goal_failed',
  'project_completed',
]);

export function importanceOf(event: NewEvent): Importance {
  return event.importance ?? DEFAULT_IMPORTANCE[event.type];
}

export function isNotable(event: WorldEvent, threshold: number): boolean {
  return ALWAYS_NOTABLE.has(event.type) || event.importance >= threshold;
}

/** Type guard for narrowing a stored event to a specific payload shape. */
export function isEventOfType<T extends EventType>(
  event: WorldEvent,
  type: T,
): event is WorldEvent<T> {
  return event.type === type;
}
