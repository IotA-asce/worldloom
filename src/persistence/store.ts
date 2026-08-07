/**
 * The store: one open database plus every repository over it.
 *
 * Passing a single `Store` around beats threading eight repositories through
 * every constructor, and it gives one place to open a transaction that spans
 * aggregates — which matters because appending an event and debiting the ledger
 * must be atomic (ADR-0004).
 */

import { randomIdFactory, type IdFactory } from '../core/ids.ts';
import { openDatabase, type Database } from './db.ts';
import { assertSchemaCompatible, migrate } from './migrations.ts';
import { AgentRepository } from './repositories/agents.ts';
import {
  ChronicleRepository,
  ProjectRepository,
  SettlementRepository,
  StructureRepository,
} from './repositories/civilization.ts';
import { EventRepository } from './repositories/events.ts';
import { GoalRepository, PlanRepository } from './repositories/goals.ts';
import { KnowledgeRepository, MessageRepository } from './repositories/knowledge.ts';
import { LedgerRepository } from './repositories/ledger.ts';
import { MemoryRepository } from './repositories/memories.ts';
import { DecisionRepository, LlmCallRepository } from './repositories/metrics.ts';
import { SimulationRepository } from './repositories/simulation.ts';

export interface StoreOptions {
  readonly path: string;
  /** Injectable for tests, which want stable readable ids. */
  readonly ids?: IdFactory;
  /** Persist prompts and responses on decision rows. */
  readonly recordDecisionText?: boolean;
  readonly readWrite?: boolean;
}

export class Store {
  readonly db: Database;
  readonly ids: IdFactory;

  readonly simulation: SimulationRepository;
  readonly agents: AgentRepository;
  readonly events: EventRepository;
  readonly goals: GoalRepository;
  readonly plans: PlanRepository;
  readonly memories: MemoryRepository;
  readonly knowledge: KnowledgeRepository;
  readonly messages: MessageRepository;
  readonly ledger: LedgerRepository;
  readonly decisions: DecisionRepository;
  readonly llmCalls: LlmCallRepository;

  /** Civilization-level state: public facts, not anyone's beliefs (ADR-0007). */
  readonly settlements: SettlementRepository;
  readonly structures: StructureRepository;
  readonly projects: ProjectRepository;
  readonly chronicle: ChronicleRepository;

  private constructor(db: Database, options: StoreOptions) {
    this.db = db;
    this.ids = options.ids ?? randomIdFactory();

    this.simulation = new SimulationRepository(db);
    this.agents = new AgentRepository(db);
    this.events = new EventRepository(db, this.ids);
    this.goals = new GoalRepository(db);
    this.plans = new PlanRepository(db);
    this.memories = new MemoryRepository(db, this.ids);
    this.knowledge = new KnowledgeRepository(db);
    this.messages = new MessageRepository(db, this.ids);
    this.ledger = new LedgerRepository(db);
    this.decisions = new DecisionRepository(db, this.ids, options.recordDecisionText ?? true);
    this.llmCalls = new LlmCallRepository(db, this.ids);

    this.settlements = new SettlementRepository(db);
    this.structures = new StructureRepository(db);
    this.projects = new ProjectRepository(db);
    this.chronicle = new ChronicleRepository(db);
  }

  /** Open (creating if needed) and migrate to the current schema version. */
  static open(options: StoreOptions | string): Store {
    const opts: StoreOptions = typeof options === 'string' ? { path: options } : options;
    const db = openDatabase(
      opts.readWrite === false ? { path: opts.path, readWrite: false } : { path: opts.path },
    );
    assertSchemaCompatible(db);
    if (opts.readWrite !== false) {
      migrate(db);
    }
    return new Store(db, opts);
  }

  /** An in-memory store for tests. Deterministic ids by default. */
  static openMemory(ids?: IdFactory): Store {
    const options: StoreOptions = ids === undefined ? { path: ':memory:' } : { path: ':memory:', ids };
    return Store.open(options);
  }

  /** Run `body` atomically across repositories. */
  transaction<T>(body: () => T): T {
    return this.db.transaction(body);
  }

  close(): void {
    this.db.close();
  }
}
