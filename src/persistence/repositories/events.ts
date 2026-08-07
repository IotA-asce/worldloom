/**
 * The event ledger.
 *
 * Append-only by construction: this class exposes no update or delete. That is
 * the point — the ledger is the authoritative history, and the chronicle is
 * only allowed to describe what it contains (ADR-0009).
 */

import type { AgentId, EventId } from '../../core/ids.ts';
import { type IdFactory } from '../../core/ids.ts';
import {
  importanceOf,
  type EventPayloads,
  type EventType,
  type NewEvent,
  type WorldEvent,
} from '../../events/types.ts';
import {
  jsonCol,
  nullableTextCol,
  numberCol,
  textCol,
  toJson,
  type Database,
  type Row,
} from '../db.ts';

function toEvent(row: Row): WorldEvent {
  const type = textCol(row, 'type') as EventType;
  return {
    id: textCol(row, 'id'),
    seq: numberCol(row, 'seq'),
    type,
    day: numberCol(row, 'day'),
    worldTicks: numberCol(row, 'world_ticks'),
    actorId: nullableTextCol(row, 'actor_id') as AgentId | null,
    payload: jsonCol<EventPayloads[EventType]>(row, 'payload'),
    importance: numberCol(row, 'importance'),
    recordedAt: numberCol(row, 'recorded_at'),
  };
}

export interface EventQuery {
  readonly day?: number;
  readonly sinceSeq?: number;
  readonly types?: readonly EventType[];
  readonly actorId?: AgentId;
  readonly minImportance?: number;
  readonly limit?: number;
}

export class EventRepository {
  constructor(
    private readonly db: Database,
    private readonly ids: IdFactory,
  ) {}

  /**
   * Append an event. Returns the stored event, including the sequence number
   * the store assigned — callers link memories and decisions to it.
   */
  append<T extends EventType>(
    event: NewEvent<T>,
    context: { day: number; worldTicks: number },
    now: number = Date.now(),
  ): WorldEvent<T> {
    const id = this.ids.next('evt');
    const importance = importanceOf(event);
    const result = this.db
      .prepare(
        `INSERT INTO events (id, type, day, world_ticks, actor_id, payload, importance, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        event.type,
        context.day,
        context.worldTicks,
        event.actorId,
        toJson(event.payload),
        importance,
        now,
      );

    return {
      id,
      seq: Number(result.lastInsertRowid),
      type: event.type,
      day: context.day,
      worldTicks: context.worldTicks,
      actorId: event.actorId,
      payload: event.payload,
      importance,
      recordedAt: now,
    };
  }

  /** Append several events atomically — used when one action produces a set. */
  appendAll(
    events: readonly NewEvent[],
    context: { day: number; worldTicks: number },
    now: number = Date.now(),
  ): WorldEvent[] {
    return this.db.transaction(() => events.map((event) => this.append(event, context, now)));
  }

  find(id: EventId | string): WorldEvent | null {
    const row = this.db.prepare('SELECT * FROM events WHERE id = ?').get(id);
    return row === undefined ? null : toEvent(row);
  }

  query(query: EventQuery = {}): WorldEvent[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];

    if (query.day !== undefined) {
      clauses.push('day = ?');
      params.push(query.day);
    }
    if (query.sinceSeq !== undefined) {
      clauses.push('seq > ?');
      params.push(query.sinceSeq);
    }
    if (query.actorId !== undefined) {
      clauses.push('actor_id = ?');
      params.push(query.actorId);
    }
    if (query.minImportance !== undefined) {
      clauses.push('importance >= ?');
      params.push(query.minImportance);
    }
    if (query.types !== undefined && query.types.length > 0) {
      clauses.push(`type IN (${query.types.map(() => '?').join(', ')})`);
      params.push(...query.types);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = query.limit === undefined ? '' : `LIMIT ${Math.max(1, Math.floor(query.limit))}`;
    return this.db
      .prepare(`SELECT * FROM events ${where} ORDER BY seq ASC ${limit}`)
      .all(...params)
      .map(toEvent);
  }

  /** Most recent events first — the "LIVE" feed of the dashboard. */
  recent(limit = 20): WorldEvent[] {
    return this.db
      .prepare('SELECT * FROM events ORDER BY seq DESC LIMIT ?')
      .all(Math.max(1, Math.floor(limit)))
      .map(toEvent);
  }

  latestSeq(): number {
    const row = this.db.prepare('SELECT MAX(seq) AS seq FROM events').get();
    const value = row?.seq;
    return typeof value === 'number' ? value : 0;
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM events').get();
    return row === undefined ? 0 : numberCol(row, 'n');
  }

  /** Event counts by type — a cheap health check on a long run. */
  countsByType(): Map<EventType, number> {
    const rows = this.db.prepare('SELECT type, COUNT(*) AS n FROM events GROUP BY type').all();
    const out = new Map<EventType, number>();
    for (const row of rows) {
      out.set(textCol(row, 'type') as EventType, numberCol(row, 'n'));
    }
    return out;
  }

  /** The highest day present in the ledger, for resuming a run. */
  latestDay(): number {
    const row = this.db.prepare('SELECT MAX(day) AS day FROM events').get();
    const value = row?.day;
    return typeof value === 'number' ? value : 0;
  }
}
