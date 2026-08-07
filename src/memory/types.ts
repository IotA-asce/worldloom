/**
 * Memory, knowledge and relationships — all strictly per-agent (ADR-0007).
 *
 * Every row here carries a `source`, so "how does Mira know that?" is always
 * answerable. Knowledge that arrived socially records who said it, which is what
 * lets trust and misinformation mean something later.
 */

import type { AgentId, EventId, MemoryId } from '../core/ids.ts';
import type { Position, ResourceKind } from '../core/world.ts';

export const MEMORY_TYPES = ['working', 'episodic', 'semantic', 'relationship'] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/**
 * How a piece of knowledge was acquired. The closed set is the enforcement
 * point for knowledge boundaries: there is no `omniscient` variant, so nothing
 * can be inserted without claiming a plausible provenance.
 */
export type KnowledgeSource =
  | { readonly kind: 'observed' }
  | { readonly kind: 'told_by'; readonly agentId: AgentId }
  | { readonly kind: 'inferred'; readonly from: readonly MemoryId[] }
  | { readonly kind: 'settlement_record' }
  /** Knowledge an agent begins the scenario with — its background, not magic. */
  | { readonly kind: 'innate' };

export const OBSERVED: KnowledgeSource = { kind: 'observed' };

export function toldBy(agentId: AgentId): KnowledgeSource {
  return { kind: 'told_by', agentId };
}

export function inferredFrom(memories: readonly MemoryId[]): KnowledgeSource {
  return { kind: 'inferred', from: memories };
}

/** Compact serialisation for storage and for display in the CLI. */
export function formatSource(source: KnowledgeSource): string {
  switch (source.kind) {
    case 'observed':
      return 'observed';
    case 'told_by':
      return `told_by:${source.agentId}`;
    case 'inferred':
      return `inferred:${source.from.join('+')}`;
    case 'settlement_record':
      return 'settlement_record';
    case 'innate':
      return 'innate';
  }
}

export interface MemoryEntry {
  readonly id: MemoryId;
  readonly agentId: AgentId;
  readonly type: MemoryType;
  /** A single fact or episode, in one or two sentences. */
  readonly content: string;
  readonly importance: number;
  readonly confidence: number;
  readonly source: KnowledgeSource;
  /** Agents, structures or resources this memory concerns — the retrieval index. */
  readonly relatedEntities: readonly string[];
  /** Free tags used for relevance matching, e.g. ['iron', 'northern ridge']. */
  readonly tags: readonly string[];
  readonly createdAtDay: number;
  readonly createdAtTicks: number;
  readonly lastAccessedAtTicks: number;
  readonly accessCount: number;
  /** The event this memory records, when it came from one. */
  readonly eventId: EventId | null;
  /**
   * Set when consolidation folded this memory into a higher-level belief.
   * Consolidated memories stay retrievable at lower priority rather than being
   * deleted, so the belief's evidence survives (requirement 12).
   */
  readonly consolidatedInto: MemoryId | null;
}

export interface NewMemory {
  readonly agentId: AgentId;
  readonly type: MemoryType;
  readonly content: string;
  readonly importance: number;
  readonly source: KnowledgeSource;
  readonly confidence?: number;
  readonly relatedEntities?: readonly string[];
  readonly tags?: readonly string[];
  readonly eventId?: EventId | null;
}

// ── World knowledge ─────────────────────────────────────────────────────────

export const LOCATION_KINDS = [
  'settlement',
  'shelter',
  'storage',
  'farm',
  'water',
  'forest',
  'cave',
  'mine',
  'high_ground',
  'hazard',
  'landmark',
] as const;

export type LocationKind = (typeof LOCATION_KINDS)[number];

export interface KnownLocation {
  readonly agentId: AgentId;
  readonly position: Position;
  readonly kind: LocationKind;
  /** 0..1. Decays for places not revisited; raised by re-observation. */
  readonly confidence: number;
  readonly source: KnowledgeSource;
  readonly label: string;
  readonly discoveredAtDay: number;
  readonly lastSeenAtTicks: number;
}

export interface KnownResource {
  readonly agentId: AgentId;
  readonly resource: ResourceKind;
  readonly position: Position;
  readonly estimatedQuantity: number;
  /** Drops to 0 when a harvest attempt finds the deposit exhausted (ADR-0008). */
  readonly confidence: number;
  readonly source: KnowledgeSource;
  readonly discoveredAtDay: number;
  readonly lastSeenAtTicks: number;
}

// ── Relationships ───────────────────────────────────────────────────────────

/**
 * One agent's view of another. Asymmetric by design: Nadia may trust Elias more
 * than he trusts her, and that asymmetry is where social dynamics come from.
 *
 * `trust` and `affinity` run -1..1; `familiarity` runs 0..1 and only ever rises.
 */
export interface Relationship {
  readonly agentId: AgentId;
  readonly otherAgentId: AgentId;
  /** Reliability: do they do what they said they would? */
  readonly trust: number;
  /** Liking, independent of reliability. */
  readonly affinity: number;
  /** How well they know each other. Gates how much weight the other two carry. */
  readonly familiarity: number;
  readonly interactions: number;
  /** The event that last moved these numbers — requirement 47's "explain why". */
  readonly lastEventId: EventId | null;
  readonly lastReason: string | null;
  readonly updatedAtTicks: number;
}

export function neutralRelationship(
  agentId: AgentId,
  otherAgentId: AgentId,
  atTicks: number,
): Relationship {
  return {
    agentId,
    otherAgentId,
    trust: 0,
    affinity: 0,
    familiarity: 0,
    interactions: 0,
    lastEventId: null,
    lastReason: null,
    updatedAtTicks: atTicks,
  };
}

/** A short characterisation, used in prompts and the CLI. */
export function describeRelationship(relationship: Relationship): string {
  const { trust, affinity, familiarity } = relationship;
  if (familiarity < 0.2) return 'barely acquainted';

  const trustWord =
    trust > 0.5 ? 'dependable' : trust > 0.15 ? 'reliable enough' : trust < -0.5 ? 'untrustworthy' : trust < -0.15 ? 'unreliable' : 'untested';
  const affinityWord =
    affinity > 0.5 ? 'liked' : affinity < -0.5 ? 'disliked' : 'neutral';
  return `${trustWord}, ${affinityWord}`;
}

// ── Messages ────────────────────────────────────────────────────────────────

export interface Message {
  readonly id: string;
  readonly fromAgentId: AgentId;
  readonly toAgentId: AgentId;
  readonly content: string;
  readonly sentAtTicks: number;
  readonly sentAtDay: number;
  /** Null until the recipient drains it at INTEGRATE. */
  readonly readAtTicks: number | null;
}
