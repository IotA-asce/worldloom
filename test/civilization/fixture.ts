/**
 * Shared setup for the civilization tests.
 *
 * The five settlers come from the real scenario rather than from hand-written
 * profiles: the criterion these tests exist to prove is about *those* five skill
 * profiles, and a fixture that invented its own would prove nothing about the run.
 */

import type { Agent } from '../../src/agents/agent.ts';
import { findBlueprint, structureTypeOf } from '../../src/civilization/blueprints.ts';
import { applyStructureCompleted } from '../../src/civilization/settlement.ts';
import { establishSettlement } from '../../src/civilization/settlement.ts';
import type { Structure } from '../../src/civilization/types.ts';
import { sequentialIdFactory, type AgentId, type SettlementId, type StructureId } from '../../src/core/ids.ts';
import { createRng } from '../../src/core/rng.ts';
import {
  blueprintRegion,
  position,
  type Position,
  type WorldTime,
} from '../../src/core/world.ts';
import { Store } from '../../src/persistence/store.ts';
import { foundSettlement, SETTLEMENT_OBJECTIVE } from '../../src/scenarios/first-settlement.ts';

export const CENTER: Position = position(0, 64, 0);

export function worldTime(overrides: Partial<WorldTime> = {}): WorldTime {
  return {
    totalTicks: 1_000,
    day: 1,
    phase: 'day',
    isDay: true,
    weather: 'clear',
    ...overrides,
  };
}

export function ticksOf(time: WorldTime): { day: number; worldTicks: number } {
  return { day: time.day, worldTicks: time.totalTicks };
}

export interface Fixture {
  readonly store: Store;
  readonly settlementId: SettlementId;
  readonly agents: readonly Agent[];
  readonly time: WorldTime;
  /** Settlers by name, so a test can say what it means. */
  settler(name: string): Agent;
}

/** A settlement with its five settlers, no structures, and an empty shared store. */
export function firstSettlement(agentCount = 5): Fixture {
  const store = Store.openMemory(sequentialIdFactory());
  store.simulation.initialise('civilization-test', 1, 1_700_000_000_000);
  const time = worldTime();

  const setup = foundSettlement({
    store,
    ids: store.ids,
    rng: createRng(1),
    center: CENTER,
    agentCount,
    day: time.day,
    worldTicks: time.totalTicks,
  });

  // The scenario appends the founding event; this projects it into a row.
  const settlement = establishSettlement(store, {
    name: setup.settlementName,
    objective: SETTLEMENT_OBJECTIVE,
    center: setup.center,
    time: ticksOf(time),
  });

  return {
    store,
    settlementId: settlement.id,
    agents: setup.agents,
    time,
    settler(name: string): Agent {
      const found = setup.agents.find((agent) => agent.name === name);
      if (found === undefined) throw new Error(`no settler named ${name}`);
      return found;
    },
  };
}

export interface BuiltOptions {
  readonly blueprint: string;
  readonly builders: readonly AgentId[];
  readonly at?: Position;
  readonly time?: WorldTime;
}

/**
 * A verified build: the event first, then the projection.
 *
 * That order is the one the simulation uses — the ledger records that the world
 * was read back and agreed, and the tables follow — so a test built this way can
 * be rebuilt from its own events.
 */
export function buildStructure(fixture: Fixture, options: BuiltOptions): Structure {
  const blueprint = findBlueprint(options.blueprint);
  if (blueprint === null) throw new Error(`no blueprint ${options.blueprint}`);
  const time = options.time ?? fixture.time;
  const type = structureTypeOf(options.blueprint);

  const payload = {
    structureId: fixture.store.ids.next('struct') as StructureId,
    type,
    region: blueprintRegion(blueprint, options.at ?? CENTER),
    builders: options.builders,
    purpose: `a ${type} for the settlement`,
  };

  fixture.store.events.append(
    { type: 'structure_completed', actorId: options.builders[0] ?? null, payload },
    ticksOf(time),
  );
  return applyStructureCompleted(fixture.store, payload, ticksOf(time));
}
