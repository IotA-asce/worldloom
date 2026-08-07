/**
 * World knowledge, relationships and messages — all per-agent (ADR-0007).
 *
 * Knowledge is stored per agent rather than in a shared world model with
 * visibility filters, precisely so that omniscience can't leak through a
 * forgotten filter. Divergence between agents is expected and correct: Arun's
 * 60%-confidence iron deposit and Mira's 90% one are different rows.
 */

import type { AgentId, EventId, MessageId } from '../../core/ids.ts';
import { type IdFactory } from '../../core/ids.ts';
import type {
  KnowledgeSource,
  KnownLocation,
  KnownResource,
  LocationKind,
  Message,
  Relationship,
} from '../../memory/types.ts';
import { horizontalDistance, type Position, type ResourceKind } from '../../core/world.ts';
import {
  jsonCol,
  nullableNumberCol,
  nullableTextCol,
  numberCol,
  textCol,
  toJson,
  type Database,
  type Row,
} from '../db.ts';

function toKnownLocation(row: Row): KnownLocation {
  return {
    agentId: textCol(row, 'agent_id') as AgentId,
    position: { x: numberCol(row, 'x'), y: numberCol(row, 'y'), z: numberCol(row, 'z') },
    kind: textCol(row, 'kind') as LocationKind,
    confidence: numberCol(row, 'confidence'),
    source: jsonCol<KnowledgeSource>(row, 'source'),
    label: textCol(row, 'label'),
    discoveredAtDay: numberCol(row, 'discovered_at_day'),
    lastSeenAtTicks: numberCol(row, 'last_seen_at_ticks'),
  };
}

function toKnownResource(row: Row): KnownResource {
  return {
    agentId: textCol(row, 'agent_id') as AgentId,
    resource: textCol(row, 'resource') as ResourceKind,
    position: { x: numberCol(row, 'x'), y: numberCol(row, 'y'), z: numberCol(row, 'z') },
    estimatedQuantity: numberCol(row, 'estimated_quantity'),
    confidence: numberCol(row, 'confidence'),
    source: jsonCol<KnowledgeSource>(row, 'source'),
    discoveredAtDay: numberCol(row, 'discovered_at_day'),
    lastSeenAtTicks: numberCol(row, 'last_seen_at_ticks'),
  };
}

export class KnowledgeRepository {
  constructor(private readonly db: Database) {}

  // ── Locations ─────────────────────────────────────────────────────────────

  /**
   * Record or refresh a known location. Re-observing raises confidence rather
   * than replacing the row, so a place seen repeatedly is trusted more.
   */
  rememberLocation(location: KnownLocation): void {
    this.db
      .prepare(
        `INSERT INTO known_locations (agent_id, x, y, z, kind, confidence, source, label,
                                      discovered_at_day, last_seen_at_ticks)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (agent_id, x, y, z, kind) DO UPDATE SET
           confidence         = MAX(confidence, excluded.confidence),
           label              = excluded.label,
           last_seen_at_ticks = excluded.last_seen_at_ticks`,
      )
      .run(
        location.agentId,
        Math.floor(location.position.x),
        Math.floor(location.position.y),
        Math.floor(location.position.z),
        location.kind,
        location.confidence,
        toJson(location.source),
        location.label,
        location.discoveredAtDay,
        location.lastSeenAtTicks,
      );
  }

  knownLocations(agentId: AgentId, kind?: LocationKind): KnownLocation[] {
    const sql =
      kind === undefined
        ? 'SELECT * FROM known_locations WHERE agent_id = ? ORDER BY confidence DESC'
        : 'SELECT * FROM known_locations WHERE agent_id = ? AND kind = ? ORDER BY confidence DESC';
    const params = kind === undefined ? [agentId] : [agentId, kind];
    return this.db.prepare(sql).all(...params).map(toKnownLocation);
  }

  /** Nearest known location of a kind, by horizontal distance. */
  nearestLocation(agentId: AgentId, kind: LocationKind, from: Position): KnownLocation | null {
    const candidates = this.knownLocations(agentId, kind);
    let best: KnownLocation | null = null;
    let bestDistance = Infinity;
    for (const candidate of candidates) {
      const d = horizontalDistance(from, candidate.position);
      if (d < bestDistance) {
        bestDistance = d;
        best = candidate;
      }
    }
    return best;
  }

  knowsLocation(agentId: AgentId, position: Position, kind: LocationKind): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM known_locations
          WHERE agent_id = ? AND x = ? AND y = ? AND z = ? AND kind = ?`,
      )
      .get(
        agentId,
        Math.floor(position.x),
        Math.floor(position.y),
        Math.floor(position.z),
        kind,
      );
    return row !== undefined;
  }

  // ── Resources ─────────────────────────────────────────────────────────────

  rememberResource(resource: KnownResource): void {
    this.db
      .prepare(
        `INSERT INTO known_resources (agent_id, resource, x, y, z, estimated_quantity,
                                      confidence, source, discovered_at_day, last_seen_at_ticks)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (agent_id, resource, x, y, z) DO UPDATE SET
           estimated_quantity = excluded.estimated_quantity,
           confidence         = excluded.confidence,
           last_seen_at_ticks = excluded.last_seen_at_ticks`,
      )
      .run(
        resource.agentId,
        resource.resource,
        Math.floor(resource.position.x),
        Math.floor(resource.position.y),
        Math.floor(resource.position.z),
        resource.estimatedQuantity,
        resource.confidence,
        toJson(resource.source),
        resource.discoveredAtDay,
        resource.lastSeenAtTicks,
      );
  }

  /** Known deposits the agent still believes in, best first. */
  knownResources(agentId: AgentId, resource?: ResourceKind, minConfidence = 0.01): KnownResource[] {
    const clauses = ['agent_id = ?', 'confidence >= ?'];
    const params: (string | number)[] = [agentId, minConfidence];
    if (resource !== undefined) {
      clauses.push('resource = ?');
      params.push(resource);
    }
    return this.db
      .prepare(
        `SELECT * FROM known_resources WHERE ${clauses.join(' AND ')}
          ORDER BY confidence DESC, estimated_quantity DESC`,
      )
      .all(...params)
      .map(toKnownResource);
  }

  /**
   * The agent learned this deposit isn't what it thought. Called when a harvest
   * fails — this is how failure teaches rather than merely frustrating
   * (ADR-0008).
   */
  correctResourceBelief(
    agentId: AgentId,
    resource: ResourceKind,
    position: Position,
    confidence: number,
    estimatedQuantity?: number,
  ): void {
    this.db
      .prepare(
        `UPDATE known_resources
            SET confidence = ?,
                estimated_quantity = COALESCE(?, estimated_quantity)
          WHERE agent_id = ? AND resource = ? AND x = ? AND y = ? AND z = ?`,
      )
      .run(
        confidence,
        estimatedQuantity ?? null,
        agentId,
        resource,
        Math.floor(position.x),
        Math.floor(position.y),
        Math.floor(position.z),
      );
  }

  // ── Relationships ─────────────────────────────────────────────────────────

  /**
   * Move a relationship. Requires a reason and, normally, the event that caused
   * it — requirement 47's "an event should explain why".
   */
  adjustRelationship(
    agentId: AgentId,
    otherAgentId: AgentId,
    delta: {
      trust?: number;
      affinity?: number;
      familiarity?: number;
      reason: string;
      eventId?: EventId | null;
    },
    worldTicks: number,
  ): Relationship {
    return this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO relationships (agent_id, other_agent_id, trust, affinity, familiarity,
                                      interactions, last_event_id, last_reason, updated_at_ticks)
           VALUES (?, ?, 0, 0, 0, 0, NULL, NULL, ?)
           ON CONFLICT (agent_id, other_agent_id) DO NOTHING`,
        )
        .run(agentId, otherAgentId, worldTicks);

      this.db
        .prepare(
          `UPDATE relationships SET
             trust       = MAX(-1.0, MIN(1.0, trust + ?)),
             affinity    = MAX(-1.0, MIN(1.0, affinity + ?)),
             familiarity = MAX(0.0, MIN(1.0, familiarity + ?)),
             interactions = interactions + 1,
             last_event_id = ?,
             last_reason = ?,
             updated_at_ticks = ?
           WHERE agent_id = ? AND other_agent_id = ?`,
        )
        .run(
          delta.trust ?? 0,
          delta.affinity ?? 0,
          delta.familiarity ?? 0,
          delta.eventId ?? null,
          delta.reason,
          worldTicks,
          agentId,
          otherAgentId,
        );

      const row = this.db
        .prepare('SELECT * FROM relationships WHERE agent_id = ? AND other_agent_id = ?')
        .get(agentId, otherAgentId);
      if (row === undefined) throw new Error('relationship vanished mid-transaction');
      return this.toRelationship(row);
    });
  }

  relationship(agentId: AgentId, otherAgentId: AgentId): Relationship | null {
    const row = this.db
      .prepare('SELECT * FROM relationships WHERE agent_id = ? AND other_agent_id = ?')
      .get(agentId, otherAgentId);
    return row === undefined ? null : this.toRelationship(row);
  }

  /** This agent's view of everyone it knows. Never the reverse direction. */
  relationshipsFor(agentId: AgentId): Relationship[] {
    return this.db
      .prepare('SELECT * FROM relationships WHERE agent_id = ? ORDER BY familiarity DESC')
      .all(agentId)
      .map((row) => this.toRelationship(row));
  }

  private toRelationship(row: Row): Relationship {
    return {
      agentId: textCol(row, 'agent_id') as AgentId,
      otherAgentId: textCol(row, 'other_agent_id') as AgentId,
      trust: numberCol(row, 'trust'),
      affinity: numberCol(row, 'affinity'),
      familiarity: numberCol(row, 'familiarity'),
      interactions: numberCol(row, 'interactions'),
      lastEventId: nullableTextCol(row, 'last_event_id') as EventId | null,
      lastReason: nullableTextCol(row, 'last_reason'),
      updatedAtTicks: numberCol(row, 'updated_at_ticks'),
    };
  }
}

export class MessageRepository {
  constructor(
    private readonly db: Database,
    private readonly ids: IdFactory,
  ) {}

  send(
    fromAgentId: AgentId,
    toAgentId: AgentId,
    content: string,
    context: { day: number; worldTicks: number },
  ): Message {
    const id = this.ids.next('msg');
    this.db
      .prepare(
        `INSERT INTO messages (id, from_agent_id, to_agent_id, content,
                               sent_at_ticks, sent_at_day, read_at_ticks)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(id, fromAgentId, toAgentId, content, context.worldTicks, context.day);

    return {
      id,
      fromAgentId,
      toAgentId,
      content,
      sentAtTicks: context.worldTicks,
      sentAtDay: context.day,
      readAtTicks: null,
    };
  }

  /** Unread messages for one recipient — drained at the INTEGRATE phase. */
  inbox(agentId: AgentId): Message[] {
    return this.db
      .prepare(
        `SELECT * FROM messages WHERE to_agent_id = ? AND read_at_ticks IS NULL
          ORDER BY sent_at_ticks ASC`,
      )
      .all(agentId)
      .map((row) => this.toMessage(row));
  }

  markRead(ids: readonly MessageId[], worldTicks: number): void {
    if (ids.length === 0) return;
    const statement = this.db.prepare(
      'UPDATE messages SET read_at_ticks = ? WHERE id = ? AND read_at_ticks IS NULL',
    );
    this.db.transaction(() => {
      for (const id of ids) statement.run(worldTicks, id);
    });
  }

  /** Conversation history involving an agent, newest first. */
  historyFor(agentId: AgentId, limit = 50): Message[] {
    return this.db
      .prepare(
        `SELECT * FROM messages WHERE from_agent_id = ? OR to_agent_id = ?
          ORDER BY sent_at_ticks DESC LIMIT ?`,
      )
      .all(agentId, agentId, Math.max(1, Math.floor(limit)))
      .map((row) => this.toMessage(row));
  }

  private toMessage(row: Row): Message {
    return {
      id: textCol(row, 'id'),
      fromAgentId: textCol(row, 'from_agent_id') as AgentId,
      toAgentId: textCol(row, 'to_agent_id') as AgentId,
      content: textCol(row, 'content'),
      sentAtTicks: numberCol(row, 'sent_at_ticks'),
      sentAtDay: numberCol(row, 'sent_at_day'),
      readAtTicks: nullableNumberCol(row, 'read_at_ticks'),
    };
  }
}
