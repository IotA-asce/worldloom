/**
 * The simulation: everything wired together, and the loop that runs it.
 *
 * M1 ticks agents in sequence. The scheduler that interleaves them with a
 * concurrency cap is M3 (ADR-0005) — correctness before concurrency, and a
 * sequential loop makes the first end-to-end run debuggable.
 */

import { isAlive, type Agent } from './agents/agent.ts';
import { describeAgentState, tickAgent, type TickReport } from './agents/runtime.ts';
import type { WorldloomConfig } from './core/config.ts';
import { createRng, type Rng } from './core/rng.ts';
import { randomIdFactory, type IdFactory } from './core/ids.ts';
import { ok, type Result } from './core/result.ts';
import type { Position } from './core/world.ts';
import { createEnvironment, type EnvironmentHandle } from './environment/index.ts';
import type { Environment } from './environment/port.ts';
import { createLogger, silentLogger, type Logger } from './observability/logger.ts';
import { Store } from './persistence/store.ts';
import { createReasoningProvider } from './reasoning/index.ts';
import type { ReasoningProvider } from './reasoning/provider.ts';
import { foundSettlement, SETTLEMENT_OBJECTIVE } from './scenarios/first-settlement.ts';

export interface SimulationOptions {
  readonly config: WorldloomConfig;
  /** Overrides for tests: supply a fake environment or a scripted provider. */
  readonly environment?: Environment;
  readonly reasoning?: ReasoningProvider;
  readonly store?: Store;
  readonly logger?: Logger;
  readonly ids?: IdFactory;
  readonly apiKey?: string | undefined;
}

export class Simulation {
  readonly store: Store;
  readonly environment: Environment;
  readonly reasoning: ReasoningProvider;
  readonly config: WorldloomConfig;
  readonly logger: Logger;
  readonly rng: Rng;
  readonly ids: IdFactory;

  private readonly ownedStore: boolean;
  private readonly environmentHandle: EnvironmentHandle | null;
  /** Shared with the provider's usage callback, which is built before the
   *  Simulation exists — hence a small box rather than a field. */
  private readonly spend: { usd: number };
  private stopping = false;

  private constructor(parts: {
    store: Store;
    environment: Environment;
    reasoning: ReasoningProvider;
    config: WorldloomConfig;
    logger: Logger;
    ids: IdFactory;
    ownedStore: boolean;
    environmentHandle: EnvironmentHandle | null;
    spend: { usd: number };
  }) {
    this.store = parts.store;
    this.environment = parts.environment;
    this.reasoning = parts.reasoning;
    this.config = parts.config;
    this.logger = parts.logger;
    this.ids = parts.ids;
    this.rng = createRng(parts.config.simulation.seed);
    this.ownedStore = parts.ownedStore;
    this.environmentHandle = parts.environmentHandle;
    this.spend = parts.spend;
  }

  static create(options: SimulationOptions): Simulation {
    const { config } = options;
    const ids = options.ids ?? randomIdFactory();
    const logger =
      options.logger ??
      createLogger({ level: config.logging.level, format: config.logging.format });

    const store =
      options.store ??
      Store.open({
        path: config.persistence.database,
        ids,
        recordDecisionText: config.logging.record_decisions,
      });

    let environment = options.environment;
    let environmentHandle: EnvironmentHandle | null = null;
    if (environment === undefined) {
      environmentHandle = createEnvironment(config);
      environment = environmentHandle.environment;
    }

    const spend = { usd: 0 };
    let reasoning = options.reasoning;

    if (reasoning === undefined) {
      // Every attempt is metered here, so cost accounting is complete by
      // construction rather than by remembering to log (requirement 29).
      const selection = createReasoningProvider({
        config,
        apiKey: options.apiKey,
        onUsage: (record) => {
          spend.usd += record.costUsd;
          store.llmCalls.record({
            // Attributed, so "which agent is expensive?" is answerable.
            agentId: record.agentId,
            category: record.category,
            provider: 'anthropic',
            model: record.model,
            inputTokens: record.usage.inputTokens,
            outputTokens: record.usage.outputTokens,
            costUsd: record.costUsd,
            durationMs: record.durationMs,
            day: store.simulation.exists() ? store.simulation.get().worldDay : 0,
            ok: record.ok,
            error: record.error,
            createdAt: Date.now(),
          });
        },
        spentUsd: () => spend.usd,
      });
      reasoning = selection.provider;
      logger.info(`Reasoning: ${selection.reason}`);
    }

    return new Simulation({
      store,
      environment,
      reasoning,
      config,
      logger,
      ids,
      ownedStore: options.store === undefined,
      environmentHandle,
      spend,
    });
  }

  /** Connect, create or resume the civilization, and report what we found. */
  async start(center?: Position): Promise<Result<{ resumed: boolean; agents: readonly Agent[] }>> {
    const connected = await this.environment.connect();
    if (!connected.ok) return connected;

    const info = connected.value;
    this.logger.info(
      `Environment: ${info.kind} (${info.embodiment} embodiment)`,
    );

    const resuming = this.store.simulation.exists() && this.store.agents.count() > 0;
    this.store.simulation.initialise(this.config.simulation.scenario, this.config.simulation.seed);

    const time = await this.environment.worldTime();
    const worldTime = time.ok
      ? this.store.simulation.advanceClock(time.value.totalTicks % 24_000, time.value.weather)
      : this.store.simulation.currentTime();

    if (resuming) {
      const agents = this.store.agents.all();
      this.store.events.appendAll(
        [
          {
            type: 'simulation_resumed',
            actorId: null,
            payload: { scenario: this.config.simulation.scenario, fromDay: worldTime.day },
          },
        ],
        { day: worldTime.day, worldTicks: worldTime.totalTicks },
      );
      this.logger.info(
        `Resuming ${this.config.simulation.scenario} on day ${worldTime.day} with ${agents.length} settlers`,
      );
      return ok({ resumed: true, agents });
    }

    // A fresh world: pick somewhere to arrive, then found the settlement.
    const site = center ?? (await this.chooseArrivalSite());
    this.store.events.appendAll(
      [
        {
          type: 'simulation_started',
          actorId: null,
          payload: {
            scenario: this.config.simulation.scenario,
            agents: this.config.simulation.agents,
            seed: this.config.simulation.seed,
          },
        },
      ],
      { day: worldTime.day, worldTicks: worldTime.totalTicks },
    );

    // Resolve each settler's standing height from a single survey of the camp,
    // rather than one round trip per settler.
    const camp = await this.environment.surveyRegion(
      {
        min: { x: site.x - 12, y: info.elevationRange.min, z: site.z - 12 },
        max: { x: site.x + 12, y: info.elevationRange.max, z: site.z + 12 },
      },
      1,
    );
    const ground = new Map<string, number>();
    if (camp.ok) {
      for (const cell of camp.value.cells) ground.set(`${cell.x},${cell.z}`, cell.y);
    }

    const setup = foundSettlement({
      store: this.store,
      ids: this.ids,
      rng: this.rng,
      center: site,
      surfaceAt: (x, z) => ground.get(`${Math.round(x)},${Math.round(z)}`) ?? null,
      agentCount: this.config.simulation.agents,
      day: worldTime.day,
      worldTicks: worldTime.totalTicks,
    });

    for (const agent of setup.agents) {
      await this.environment.presentAgent({
        id: agent.id,
        name: agent.name,
        position: agent.position,
      });
    }

    this.logger.info(`${setup.settlementName} founded — ${SETTLEMENT_OBJECTIVE}`);
    for (const agent of setup.agents) {
      this.logger.info(`  ${agent.name} (${agent.role}) arrived`);
    }

    return ok({ resumed: false, agents: setup.agents });
  }

  /**
   * Tick every living agent once, in a shuffled order so no agent permanently
   * gets first pick of contested work (ADR-0005).
   */
  async tickAll(): Promise<TickReport[]> {
    const living = this.rng.shuffle(this.store.agents.living());
    const reports: TickReport[] = [];
    for (const agent of living) {
      if (this.stopping) break;
      const report = await tickAgent(agent.id, {
        store: this.store,
        environment: this.environment,
        reasoning: this.reasoning,
        config: this.config,
        log: (message, fields) => this.logger.info(message, fields),
      });
      if (report.ok) reports.push(report.value);
    }
    return reports;
  }

  /** Run until `maxDays` elapses, or until stopped. */
  async run(): Promise<void> {
    const maxDays = this.config.simulation.max_days;
    const intervalMs = this.config.simulation.tick_interval_seconds * 1000;
    let lastDay = this.store.simulation.currentTime().day;

    while (!this.stopping) {
      await this.tickAll();

      const now = this.store.simulation.currentTime();
      if (now.day !== lastDay) {
        lastDay = now.day;
        this.store.events.appendAll(
          [{ type: 'day_began', actorId: null, payload: { day: now.day } }],
          { day: now.day, worldTicks: now.totalTicks },
        );
        this.logger.info(`— Day ${now.day} —`);
      }

      if (maxDays !== null && now.day >= maxDays) {
        this.logger.info(`Reached day ${now.day}; stopping.`);
        break;
      }

      if (intervalMs > 0 && !this.stopping) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }
  }

  stop(): void {
    this.stopping = true;
  }

  /** Estimated spend so far, in USD. */
  spentUsd(): number {
    return this.spend.usd;
  }

  /** One line per agent, for the status display. */
  status(): string[] {
    return this.store.agents.all().map((agent) => {
      const goal = agent.currentGoalId === null ? null : this.store.goals.find(agent.currentGoalId);
      const plan = goal === null ? null : this.store.plans.activeForGoal(goal.id);
      const line = describeAgentState(agent, goal, plan);
      return isAlive(agent) ? line : `${line} (dead)`;
    });
  }

  async close(): Promise<void> {
    this.stop();
    await this.reasoning.close?.();
    if (this.environmentHandle !== null) {
      await this.environmentHandle.close();
    } else {
      await this.environment.disconnect();
    }
    this.store.simulation.setStatus('stopped');
    if (this.ownedStore) this.store.close();
  }

  /**
   * Find somewhere sensible to arrive: flat, dry, above water. The settlers do
   * this by surveying, so the site is a consequence of the real terrain rather
   * than a constant.
   */
  private async chooseArrivalSite(): Promise<Position> {
    const info = this.environment.describe();
    const origin: Position = { x: 0, y: (info.elevationRange.min + info.elevationRange.max) / 2, z: 0 };
    const survey = await this.environment.surveyRegion(
      {
        min: { x: -64, y: info.elevationRange.min, z: -64 },
        max: { x: 64, y: info.elevationRange.max, z: 64 },
      },
      4,
    );

    if (!survey.ok || survey.value.cells.length === 0) {
      this.logger.warn('could not survey the arrival area; starting at the origin');
      return origin;
    }

    // Prefer dry ground a little above its surroundings — somewhere a settlement
    // would plausibly be founded.
    const dry = survey.value.cells.filter((cell) => cell.surface !== 'water');
    if (dry.length === 0) return origin;

    const median = [...dry].sort((a, b) => a.y - b.y)[Math.floor(dry.length / 2)]!;
    const best = dry.reduce((chosen, cell) =>
      Math.abs(cell.y - median.y) < Math.abs(chosen.y - median.y) ? cell : chosen,
    );

    return { x: best.x, y: best.y + 1, z: best.z };
  }
}

export { silentLogger };
