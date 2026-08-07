/**
 * Memory persistence.
 *
 * Every method takes an `agentId` first. That is not a stylistic choice — it is
 * the enforcement mechanism for knowledge boundaries (ADR-0007). There is
 * deliberately no `allMemories()`, so reading another agent's mind would require
 * adding a method that does not exist, which is visible in review.
 */

import type { AgentId, EventId, MemoryId } from '../../core/ids.ts';
import { type IdFactory } from '../../core/ids.ts';
import type { KnowledgeSource, MemoryEntry, MemoryType, NewMemory } from '../../memory/types.ts';
import {
  jsonCol,
  nullableTextCol,
  numberCol,
  textCol,
  toJson,
  type Database,
  type Row,
} from '../db.ts';

function toMemory(row: Row): MemoryEntry {
  return {
    id: textCol(row, 'id') as MemoryId,
    agentId: textCol(row, 'agent_id') as AgentId,
    type: textCol(row, 'type') as MemoryType,
    content: textCol(row, 'content'),
    importance: numberCol(row, 'importance'),
    confidence: numberCol(row, 'confidence'),
    source: jsonCol<KnowledgeSource>(row, 'source'),
    relatedEntities: jsonCol<string[]>(row, 'related_entities'),
    tags: jsonCol<string[]>(row, 'tags'),
    createdAtDay: numberCol(row, 'created_at_day'),
    createdAtTicks: numberCol(row, 'created_at_ticks'),
    lastAccessedAtTicks: numberCol(row, 'last_accessed_ticks'),
    accessCount: numberCol(row, 'access_count'),
    eventId: nullableTextCol(row, 'event_id') as EventId | null,
    consolidatedInto: nullableTextCol(row, 'consolidated_into') as MemoryId | null,
  };
}

export interface MemoryFilter {
  readonly types?: readonly MemoryType[];
  readonly minImportance?: number;
  /** Exclude memories already folded into a higher-level belief. */
  readonly excludeConsolidated?: boolean;
  readonly limit?: number;
}

export class MemoryRepository {
  constructor(
    private readonly db: Database,
    private readonly ids: IdFactory,
  ) {}

  insert(
    memory: NewMemory,
    context: { day: number; worldTicks: number },
  ): MemoryEntry {
    const id = this.ids.next('mem');
    const entry: MemoryEntry = {
      id,
      agentId: memory.agentId,
      type: memory.type,
      content: memory.content,
      importance: memory.importance,
      confidence: memory.confidence ?? 1,
      source: memory.source,
      relatedEntities: memory.relatedEntities ?? [],
      tags: memory.tags ?? [],
      createdAtDay: context.day,
      createdAtTicks: context.worldTicks,
      lastAccessedAtTicks: context.worldTicks,
      accessCount: 0,
      eventId: memory.eventId ?? null,
      consolidatedInto: null,
    };

    this.db
      .prepare(
        `INSERT INTO memories (id, agent_id, type, content, importance, confidence, source,
                               related_entities, tags, created_at_day, created_at_ticks,
                               last_accessed_ticks, access_count, event_id, consolidated_into)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        entry.id,
        entry.agentId,
        entry.type,
        entry.content,
        entry.importance,
        entry.confidence,
        toJson(entry.source),
        toJson(entry.relatedEntities),
        toJson(entry.tags),
        entry.createdAtDay,
        entry.createdAtTicks,
        entry.lastAccessedAtTicks,
        entry.accessCount,
        entry.eventId,
      );

    return entry;
  }

  find(agentId: AgentId, id: MemoryId): MemoryEntry | null {
    const row = this.db
      .prepare('SELECT * FROM memories WHERE id = ? AND agent_id = ?')
      .get(id, agentId);
    return row === undefined ? null : toMemory(row);
  }

  /** Candidate set for retrieval. Scoring happens in the memory module, not SQL,
   *  so relevance can consider the current decision. */
  candidates(agentId: AgentId, filter: MemoryFilter = {}): MemoryEntry[] {
    const clauses = ['agent_id = ?'];
    const params: (string | number)[] = [agentId];

    if (filter.types !== undefined && filter.types.length > 0) {
      clauses.push(`type IN (${filter.types.map(() => '?').join(', ')})`);
      params.push(...filter.types);
    }
    if (filter.minImportance !== undefined) {
      clauses.push('importance >= ?');
      params.push(filter.minImportance);
    }
    if (filter.excludeConsolidated === true) {
      clauses.push('consolidated_into IS NULL');
    }

    const limit = filter.limit === undefined ? '' : `LIMIT ${Math.max(1, Math.floor(filter.limit))}`;
    return this.db
      .prepare(
        `SELECT * FROM memories WHERE ${clauses.join(' AND ')}
          ORDER BY importance DESC, created_at_ticks DESC ${limit}`,
      )
      .all(...params)
      .map(toMemory);
  }

  /** Most recent first — the agent's own timeline. */
  recent(agentId: AgentId, limit = 20): MemoryEntry[] {
    return this.db
      .prepare('SELECT * FROM memories WHERE agent_id = ? ORDER BY created_at_ticks DESC LIMIT ?')
      .all(agentId, Math.max(1, Math.floor(limit)))
      .map(toMemory);
  }

  /**
   * What this agent remembers of one event. Usually none or one, but a single
   * event can leave both an episodic trace and a relationship note.
   *
   * This closes the last link of the causal chain: event → memory (ADR-0008).
   * Still agent-scoped, so it cannot be used to read what *another* settler made
   * of the same event.
   */
  forEvent(agentId: AgentId, eventId: EventId): MemoryEntry[] {
    return this.db
      .prepare(
        `SELECT * FROM memories WHERE agent_id = ? AND event_id = ?
          ORDER BY created_at_ticks ASC`,
      )
      .all(agentId, eventId)
      .map(toMemory);
  }

  byType(agentId: AgentId, type: MemoryType, limit = 50): MemoryEntry[] {
    return this.db
      .prepare(
        `SELECT * FROM memories WHERE agent_id = ? AND type = ?
          ORDER BY created_at_ticks DESC LIMIT ?`,
      )
      .all(agentId, type, Math.max(1, Math.floor(limit)))
      .map(toMemory);
  }

  /**
   * The newest memories of a type that no belief has been drawn from yet.
   *
   * This is the run reflection generalises over, and it has to be ordered by
   * time rather than by importance: "what has been happening to me lately" is a
   * temporal question, and `candidates` answers a relevance one.
   */
  unconsolidated(agentId: AgentId, type: MemoryType, limit = 24): MemoryEntry[] {
    return this.db
      .prepare(
        `SELECT * FROM memories
          WHERE agent_id = ? AND type = ? AND consolidated_into IS NULL
          ORDER BY created_at_ticks DESC, id DESC LIMIT ?`,
      )
      .all(agentId, type, Math.max(1, Math.floor(limit)))
      .map(toMemory);
  }

  /**
   * Record that memories were used in a decision. Access count and recency feed
   * back into retrieval scoring, so frequently useful memories stay reachable.
   */
  markAccessed(agentId: AgentId, ids: readonly MemoryId[], worldTicks: number): void {
    if (ids.length === 0) return;
    const statement = this.db.prepare(
      `UPDATE memories
          SET access_count = access_count + 1, last_accessed_ticks = ?
        WHERE id = ? AND agent_id = ?`,
    );
    this.db.transaction(() => {
      for (const id of ids) statement.run(worldTicks, id, agentId);
    });
  }

  /**
   * Update a belief in place as fresh evidence for it accumulates.
   *
   * Reflection uses this instead of writing a second near-identical belief every
   * interval: without it an agent's semantic memory fills with copies of the same
   * conclusion, which crowds retrieval and reads as thinking in circles.
   */
  reinforce(
    agentId: AgentId,
    id: MemoryId,
    update: { content: string; importance: number; confidence: number },
    worldTicks: number,
  ): MemoryEntry {
    this.db
      .prepare(
        `UPDATE memories
            SET content = ?, importance = ?, confidence = ?, last_accessed_ticks = ?,
                access_count = access_count + 1
          WHERE id = ? AND agent_id = ?`,
      )
      .run(update.content, update.importance, update.confidence, worldTicks, id, agentId);

    const reinforced = this.find(agentId, id);
    if (reinforced === null) throw new Error(`cannot reinforce unknown memory ${id}`);
    return reinforced;
  }

  /** Point a batch of raw memories at the belief they were consolidated into.
   *  They stay retrievable at lower priority — the belief's evidence survives. */
  markConsolidated(agentId: AgentId, ids: readonly MemoryId[], into: MemoryId): void {
    if (ids.length === 0) return;
    const statement = this.db.prepare(
      'UPDATE memories SET consolidated_into = ? WHERE id = ? AND agent_id = ?',
    );
    this.db.transaction(() => {
      for (const id of ids) statement.run(into, id, agentId);
    });
  }

  /** Lower importance across the board — the decay half of forgetting. */
  decay(agentId: AgentId, factor: number, floor = 0.05): number {
    const result = this.db
      .prepare(
        `UPDATE memories SET importance = MAX(?, importance * ?)
          WHERE agent_id = ? AND type <> 'semantic'`,
      )
      .run(floor, factor, agentId);
    return Number(result.changes);
  }

  /** Drop consolidated memories that have decayed below the floor and were
   *  never re-accessed. True forgetting, bounded so evidence isn't lost early. */
  forget(
    agentId: AgentId,
    importanceBelow: number,
    olderThanTicks: number,
    /**
     * Ids that must survive this call, whatever their importance and age.
     *
     * The caller that needs this is consolidation: a memory it has only just
     * folded into a summary would otherwise be superseded and deleted in the
     * same breath, leaving a summary whose evidence no longer exists. There is
     * always a window in which a belief and the memories behind it coexist.
     */
    keep: readonly MemoryId[] = [],
  ): number {
    const exclusion = keep.length === 0 ? '' : ` AND id NOT IN (${keep.map(() => '?').join(', ')})`;
    const result = this.db
      .prepare(
        `DELETE FROM memories
          WHERE agent_id = ? AND importance < ? AND created_at_ticks < ?
            AND consolidated_into IS NOT NULL AND access_count = 0${exclusion}`,
      )
      .run(agentId, importanceBelow, olderThanTicks, ...keep);
    return Number(result.changes);
  }

  count(agentId: AgentId): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM memories WHERE agent_id = ?').get(agentId);
    return row === undefined ? 0 : numberCol(row, 'n');
  }

  /** Unconsolidated episodic count — the trigger for reflection and consolidation. */
  unconsolidatedCount(agentId: AgentId): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM memories
          WHERE agent_id = ? AND type = 'episodic' AND consolidated_into IS NULL`,
      )
      .get(agentId);
    return row === undefined ? 0 : numberCol(row, 'n');
  }
}
