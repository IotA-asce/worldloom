/**
 * The settlement, as a projection of the event ledger.
 *
 * Nothing here is a source of truth. A structure stands because a
 * `structure_completed` event says a build was verified; the settlement's centre
 * is where `settlement_founded` put it. The tables exist so that the questions a
 * planner asks every tick — "do we have shelter yet?", "what are we short of?" —
 * cost one indexed read instead of a scan over the whole ledger.
 *
 * Because it is a projection, it must be rebuildable: `reconcileSettlementState`
 * folds the ledger back into these tables, and a wiped database that has kept its
 * events loses nothing. That property is the reason this module reads events
 * rather than being handed state by whoever happened to cause it.
 *
 * These are *public* facts (ADR-0007's one narrow exception). No agent's beliefs,
 * memories or plans are stored or read here.
 */

import { isAlive } from '../agents/agent.ts';
import type { SettlementId } from '../core/ids.ts';
import {
  bundleGet,
  bundleShortfall,
  type Position,
  type Region,
  type ResourceBundle,
} from '../core/world.ts';
import type { EventPayloads } from '../events/types.ts';
import { settlementOwner } from '../persistence/repositories/ledger.ts';
import type { Store } from '../persistence/store.ts';
import { BLUEPRINTS, costOf, structureTypeOf } from './blueprints.ts';
import type { Settlement, Structure } from './types.ts';

/** Day and world tick an operation happens at. Matches the event store's shape. */
export interface TimeContext {
  readonly day: number;
  readonly worldTicks: number;
}

/**
 * What a settlement wants built, in order.
 *
 * Shelter first because a settlement that cannot survive the night has no use
 * for a granary; storage before a farm because a harvest with nowhere to go
 * rots. The priorities are the weights coordination scores work with.
 */
export const STRUCTURE_SEQUENCE: readonly {
  readonly type: string;
  readonly blueprint: string;
  readonly priority: number;
}[] = [
  { type: 'shelter', blueprint: 'small_shelter', priority: 0.9 },
  { type: 'storage', blueprint: 'storage', priority: 0.6 },
  { type: 'farm', blueprint: 'small_farm', priority: 0.5 },
];

/** Food the settlement wants in the shared store per settler. */
export const FOOD_PER_SETTLER = 6;

// ── Founding ────────────────────────────────────────────────────────────────

export interface EstablishOptions {
  readonly name: string;
  readonly objective: string;
  readonly center: Position;
  readonly time: TimeContext;
  /** Provide the id when the caller has already minted one. */
  readonly id?: SettlementId;
}

/**
 * Ensure the settlement row exists, founding it if this world has never had one.
 *
 * Idempotent in three directions, which matters because a run may be resumed, a
 * scenario may have founded the settlement already, and the row may have been
 * lost while the ledger survived:
 *
 *  - a row already there is returned untouched;
 *  - a `settlement_founded` event with no row rebuilds the row from the event,
 *    without appending a second founding;
 *  - neither present founds the settlement for real.
 */
export function establishSettlement(store: Store, options: EstablishOptions): Settlement {
  const existing = store.settlements.primary();
  if (existing !== null) return existing;

  const founded = store.events.query({ types: ['settlement_founded'], limit: 1 })[0];
  if (founded !== undefined) {
    const payload = founded.payload as EventPayloads['settlement_founded'];
    return store.settlements.upsert({
      id: payload.settlementId,
      name: payload.name,
      objective: payload.objective,
      foundingDay: founded.day,
      center: payload.center,
      status: 'active',
    });
  }

  const id = options.id ?? (store.ids.next('stmt') as SettlementId);
  return store.transaction(() => {
    const settlement = store.settlements.upsert({
      id,
      name: options.name,
      objective: options.objective,
      foundingDay: options.time.day,
      center: options.center,
      status: 'active',
    });
    store.events.append(
      {
        type: 'settlement_founded',
        actorId: null,
        payload: {
          settlementId: id,
          name: options.name,
          center: options.center,
          objective: options.objective,
        },
      },
      { day: options.time.day, worldTicks: options.time.worldTicks },
    );
    return settlement;
  });
}

export function primarySettlement(store: Store): Settlement | null {
  return store.settlements.primary();
}

/**
 * Where the settlement is. Falls back to the founding event so this answers even
 * before the projection has been reconciled.
 */
export function settlementCenter(store: Store): Position | null {
  const settlement = store.settlements.primary();
  if (settlement !== null) return settlement.center;
  const founded = store.events.query({ types: ['settlement_founded'], limit: 1 })[0];
  if (founded === undefined) return null;
  return (founded.payload as EventPayloads['settlement_founded']).center;
}

// ── Cheap questions the planner asks every tick ──────────────────────────────

/** Structure types currently standing. `['shelter', 'storage']` and so on. */
export function standingStructureTypes(store: Store): string[] {
  return store.structures.standingTypes().sort();
}

export function hasStandingStructure(store: Store, type: string): boolean {
  return store.structures.ofType(type).length > 0;
}

/** The next thing a settlement of this maturity should have, or null when the
 *  sequence is satisfied. */
export function nextNeededStructure(
  store: Store,
): { readonly type: string; readonly blueprint: string; readonly priority: number } | null {
  const standing = new Set(store.structures.standingTypes());
  return STRUCTURE_SEQUENCE.find((wanted) => !standing.has(wanted.type)) ?? null;
}

/** The shared store — resources gathered *for the settlement* rather than kept. */
export function settlementStock(store: Store, settlementId: SettlementId): ResourceBundle {
  return store.ledger.balance(settlementOwner(settlementId));
}

/**
 * What the settlement is short of for a blueprint, counting only the shared
 * store. Defaults to the next structure in the sequence, which is the question
 * "what are we short of?" without a subject.
 */
export function settlementShortfall(
  store: Store,
  settlementId: SettlementId,
  blueprint?: string,
): ResourceBundle {
  const wanted = blueprint ?? nextNeededStructure(store)?.blueprint;
  if (wanted === undefined) return {};
  return bundleShortfall(costOf(wanted), settlementStock(store, settlementId));
}

/** How much food the shared store is short of feeding everyone. */
export function foodShortfall(store: Store, settlementId: SettlementId): number {
  const target = population(store) * FOOD_PER_SETTLER;
  return Math.max(0, target - bundleGet(settlementStock(store, settlementId), 'food'));
}

/** Living settlers. Used to size the food target, not to read anyone's state. */
export function population(store: Store): number {
  return store.agents.all().filter(isAlive).length;
}

export interface SettlementSummary {
  readonly settlement: Settlement;
  readonly population: number;
  readonly standingTypes: readonly string[];
  readonly structures: readonly Structure[];
  readonly stock: ResourceBundle;
  /** The next structure the settlement wants, and what it still lacks for it. */
  readonly wants: { readonly type: string; readonly blueprint: string } | null;
  readonly shortfall: ResourceBundle;
  readonly foodShortfall: number;
}

/** Everything a settlement-level decision needs, in one read. */
export function summariseSettlement(store: Store, settlementId?: SettlementId): SettlementSummary | null {
  const settlement =
    settlementId === undefined ? store.settlements.primary() : store.settlements.find(settlementId);
  if (settlement === null) return null;

  const wants = nextNeededStructure(store);
  return {
    settlement,
    population: population(store),
    standingTypes: standingStructureTypes(store),
    structures: store.structures.all(),
    stock: settlementStock(store, settlement.id),
    wants: wants === null ? null : { type: wants.type, blueprint: wants.blueprint },
    shortfall: settlementShortfall(store, settlement.id),
    foodShortfall: foodShortfall(store, settlement.id),
  };
}

// ── Folding events into the projection ──────────────────────────────────────

/**
 * Which blueprint produced a structure.
 *
 * `structure_completed` records the type and the region but not the blueprint,
 * so the blueprint is recovered by matching the footprint — which distinguishes
 * a five-by-five hut from a communal hall without needing the ledger to have
 * said so. Derivation rather than a schema change keeps existing runs
 * reconcilable.
 */
export function blueprintForStructure(type: string, region: Region): string {
  const candidates = Object.keys(BLUEPRINTS).filter((name) => structureTypeOf(name) === type);
  const first = candidates[0];
  if (first === undefined) return type;

  const width = region.max.x - region.min.x + 1;
  const depth = region.max.z - region.min.z + 1;
  let best = first;
  let bestError = Infinity;
  for (const name of candidates) {
    const size = BLUEPRINTS[name]?.size;
    if (size === undefined) continue;
    const error = Math.abs(size.width - width) + Math.abs(size.depth - depth);
    if (error < bestError) {
      bestError = error;
      best = name;
    }
  }
  return best;
}

/**
 * Record a verified build in the projection. Idempotent — a second call for the
 * same structure adds any builder it did not already know about and nothing
 * else, so replaying the ledger is safe.
 */
export function applyStructureCompleted(
  store: Store,
  payload: EventPayloads['structure_completed'],
  time: TimeContext,
): Structure {
  const already = store.structures.find(payload.structureId);
  if (already !== null) {
    for (const builder of payload.builders) store.structures.addBuilder(already.id, builder);
    return store.structures.find(already.id) ?? already;
  }

  const structure: Structure = {
    id: payload.structureId,
    settlementId: store.settlements.primary()?.id ?? null,
    type: payload.type,
    blueprint: blueprintForStructure(payload.type, payload.region),
    region: payload.region,
    builders: payload.builders,
    purpose: payload.purpose,
    // The event is only appended once the world has been read back and agreed
    // (see verify_structure), so a completed event *is* a verification.
    state: 'complete',
    createdAtDay: time.day,
    createdAtTicks: time.worldTicks,
    verifiedAtTicks: time.worldTicks,
  };
  store.structures.insert(structure);
  return structure;
}

export function applyStructureDamaged(
  store: Store,
  payload: EventPayloads['structure_damaged'],
): Structure | null {
  const structure = store.structures.find(payload.structureId);
  if (structure === null || structure.state === 'ruined') return structure;
  store.structures.setState(structure.id, 'damaged');
  return store.structures.find(structure.id);
}

export interface ReconcileOptions {
  /**
   * Drop the projected rows first and rebuild them from nothing. The honest test
   * of a projection, and the repair path when the tables and the ledger have
   * diverged. Off by default, so the ordinary call is a cheap catch-up.
   */
  readonly wipe?: boolean;
}

export interface ReconcileReport {
  readonly settlements: number;
  readonly structures: number;
  readonly projects: number;
  readonly claims: number;
  /** What the fold could not reproduce exactly, and why. */
  readonly gaps: readonly string[];
}

/**
 * Rebuild the settlement and structure tables from the event ledger.
 *
 * Called with `wipe` this is a full rebuild; called without, a catch-up that
 * inserts whatever rows are missing. Both are idempotent. Project rows are
 * rebuilt by `reconcileProjects` in projects.ts — with `wipe` this deletes them
 * first, because they hold foreign keys into the tables being rebuilt.
 */
export function reconcileSettlementState(
  store: Store,
  options: ReconcileOptions = {},
): ReconcileReport {
  const events = store.events.query({
    types: ['settlement_founded', 'structure_completed', 'structure_damaged'],
  });

  return store.transaction(() => {
    if (options.wipe === true) {
      // Children first: foreign keys are enforced (see openDatabase).
      store.db.prepare('DELETE FROM project_claims').run();
      store.db.prepare('DELETE FROM projects').run();
      store.db.prepare('DELETE FROM structures').run();
      store.db.prepare('DELETE FROM settlements').run();
    }

    for (const event of events) {
      const time = { day: event.day, worldTicks: event.worldTicks };
      switch (event.type) {
        case 'settlement_founded': {
          const payload = event.payload as EventPayloads['settlement_founded'];
          store.settlements.upsert({
            id: payload.settlementId,
            name: payload.name,
            objective: payload.objective,
            foundingDay: event.day,
            center: payload.center,
            status: 'active',
          });
          break;
        }
        case 'structure_completed': {
          applyStructureCompleted(store, event.payload as EventPayloads['structure_completed'], time);
          break;
        }
        case 'structure_damaged': {
          applyStructureDamaged(store, event.payload as EventPayloads['structure_damaged']);
          break;
        }
        default:
          break;
      }
    }

    return {
      settlements: store.settlements.all().length,
      structures: store.structures.count(),
      projects: 0,
      claims: 0,
      gaps: [],
    };
  });
}
