/**
 * Entity identifiers.
 *
 * Ids are prefixed so that a bare id in a log line or an event payload is
 * self-describing — `mem_7f3a2b91` needs no column name to be readable. They
 * are branded at the type level so an agent id can't be passed where a goal id
 * belongs; that mistake is otherwise invisible, since both are strings.
 */

import { randomBytes } from 'node:crypto';

declare const brand: unique symbol;
type Branded<Prefix extends string> = string & { readonly [brand]: Prefix };

export type AgentId = Branded<'agent'>;
export type GoalId = Branded<'goal'>;
export type PlanId = Branded<'plan'>;
export type MemoryId = Branded<'mem'>;
export type EventId = Branded<'evt'>;
export type MessageId = Branded<'msg'>;
export type StructureId = Branded<'struct'>;
export type ProjectId = Branded<'proj'>;
export type SettlementId = Branded<'stmt'>;
export type DecisionId = Branded<'dec'>;
export type LlmCallId = Branded<'llm'>;
export type ReservationId = Branded<'resv'>;

const PREFIXES = {
  agent: 'agent',
  goal: 'goal',
  plan: 'plan',
  mem: 'mem',
  evt: 'evt',
  msg: 'msg',
  struct: 'struct',
  proj: 'proj',
  stmt: 'stmt',
  dec: 'dec',
  llm: 'llm',
  resv: 'resv',
} as const;

export type IdPrefix = keyof typeof PREFIXES;

/**
 * Id source. Injectable so tests get stable, readable ids
 * (`agent_000001`) instead of random ones.
 */
export interface IdFactory {
  next<P extends IdPrefix>(prefix: P): Branded<P>;
}

export function randomIdFactory(): IdFactory {
  return {
    next: <P extends IdPrefix>(prefix: P) =>
      `${prefix}_${randomBytes(6).toString('hex')}` as Branded<P>,
  };
}

/** Monotonic ids for tests: deterministic, and diffable in fixtures. */
export function sequentialIdFactory(): IdFactory {
  const counters = new Map<string, number>();
  return {
    next: <P extends IdPrefix>(prefix: P) => {
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      return `${prefix}_${String(n).padStart(6, '0')}` as Branded<P>;
    },
  };
}

/** Parse the prefix back out — used when a foreign key arrives untyped. */
export function idPrefix(id: string): IdPrefix | null {
  const prefix = id.slice(0, id.indexOf('_'));
  return prefix in PREFIXES ? (prefix as IdPrefix) : null;
}

export function isId<P extends IdPrefix>(id: string, prefix: P): id is Branded<P> {
  return id.startsWith(`${prefix}_`);
}

/**
 * Assert a string is an id of the given kind. Use at trust boundaries — CLI
 * arguments, rows read from the database — rather than casting.
 */
export function asId<P extends IdPrefix>(id: string, prefix: P): Branded<P> {
  if (!isId(id, prefix)) {
    throw new Error(`expected a ${prefix} id, got '${id}'`);
  }
  return id;
}
