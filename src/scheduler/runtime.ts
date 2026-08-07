/**
 * The scheduler: who ticks, when, and how concurrently (ADR-0005).
 *
 * A round takes the living agents, shuffles them with a seeded RNG, and drains
 * that queue through a small pool of workers. Three properties matter, in this
 * order:
 *
 *  1. **Per-agent ticks never overlap with themselves.** An agent is a state
 *     machine whose phase lives in a column (ADR-0001); two ticks running against
 *     the same row would interleave reads and writes of that phase and produce a
 *     state no sequence of decisions could have reached. Correctness first —
 *     which is why an agent already in flight is deferred rather than raced.
 *  2. **A slow tick parks one worker, not the round.** Requirement 30: one four
 *     second model call must not cost the other four agents their turn. Workers
 *     pull the next agent the instant they are free, so the round costs roughly
 *     its slowest tick rather than the sum of all of them.
 *  3. **No agent permanently gets first pick.** Contested work — the last flat
 *     site, the nearest forest — would otherwise always go to whoever is first
 *     in a stable ordering. The rotation is reshuffled every round from a seeded
 *     generator, so the order is fair *and* reproducible from the config seed.
 *
 * The scheduler knows nothing about agents beyond their ids. It is handed a tick
 * function, which is what lets it be tested against staggered delays instead of
 * against the real runtime.
 */

import type { AgentId } from '../core/ids.ts';
import type { Rng } from '../core/rng.ts';
import { fail, type Result } from '../core/result.ts';

/** One tick of one agent. Returns a `Result`; failures are values (ADR-0008). */
export type TickFunction<T> = (agentId: AgentId) => Promise<Result<T>>;

export interface TickOutcome<T> {
  readonly agentId: AgentId;
  readonly result: Result<T>;
  /** Wall-clock cost of this tick, for spotting the agent that is holding a
   *  round up. Not simulation time — that comes from the world clock. */
  readonly durationMs: number;
}

export interface RoundReport<T> {
  /** In completion order, so the report reads as what actually happened. */
  readonly outcomes: readonly TickOutcome<T>[];
  /** The rotation this round intended to run, before anything was deferred. */
  readonly order: readonly AgentId[];
  /**
   * Agents skipped because a tick of theirs was still in flight. Reported rather
   * than silently dropped: a persistently deferred agent means ticks are taking
   * longer than the round interval, which is worth seeing.
   */
  readonly deferred: readonly AgentId[];
  readonly durationMs: number;
  /** The most ticks that were ever in flight together. Never exceeds the cap. */
  readonly peakConcurrency: number;
}

export interface SchedulerOptions<T> {
  readonly tick: TickFunction<T>;
  /**
   * The agents eligible this round. A function, not an array, so a round picks
   * up the agents that are alive *now* — someone who died last round should not
   * be ticked, and someone who arrived should be.
   */
  readonly agents: () => readonly AgentId[];
  /** `reasoning.max_concurrency`. Clamped to at least 1. */
  readonly maxConcurrency: number;
  readonly rng: Rng;
  /** Checked between ticks, so a stop request is honoured mid-round. */
  readonly stopping?: () => boolean;
  /** Called as each tick finishes, for live status output. */
  readonly onOutcome?: (outcome: TickOutcome<T>) => void;
  /** Injectable clock, so timing assertions in tests don't need real delays. */
  readonly now?: () => number;
}

export class Scheduler<T> {
  private readonly options: SchedulerOptions<T>;
  private readonly maxConcurrency: number;
  /**
   * Agents with a tick in flight. This set — not a lock, not a queue discipline —
   * is what enforces property 1 above, and it is checked at the moment a worker
   * claims an agent rather than when the round is planned, so two overlapping
   * rounds cannot both claim the same agent.
   */
  private readonly inFlight = new Set<AgentId>();

  constructor(options: SchedulerOptions<T>) {
    this.options = options;
    this.maxConcurrency = Math.max(1, Math.floor(options.maxConcurrency));
  }

  /** How many ticks are running right now. */
  inFlightCount(): number {
    return this.inFlight.size;
  }

  isInFlight(agentId: AgentId): boolean {
    return this.inFlight.has(agentId);
  }

  /**
   * Tick every eligible agent once, up to `maxConcurrency` at a time.
   *
   * Resolves when the round's ticks have all settled. Never rejects: a tick that
   * throws becomes an `INTERNAL` failure on that agent's outcome, because one
   * agent's bug taking the whole civilization down is the failure mode a
   * long-running simulation can least afford.
   */
  async runRound(): Promise<RoundReport<T>> {
    const now = this.options.now ?? Date.now;
    const startedAt = now();

    const rotation = this.rotation();
    const queue: AgentId[] = [];
    const deferred: AgentId[] = [];
    for (const agentId of rotation) {
      if (this.inFlight.has(agentId)) deferred.push(agentId);
      else queue.push(agentId);
    }

    const outcomes: TickOutcome<T>[] = [];
    const peak = { value: 0 };
    let next = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        if (this.options.stopping?.() === true) return;
        const agentId = queue[next++];
        if (agentId === undefined) return;
        // Re-checked here, not only when the round was planned: another round
        // running concurrently may have claimed this agent in the meantime.
        if (this.inFlight.has(agentId)) {
          deferred.push(agentId);
          continue;
        }
        const outcome = await this.runOne(agentId, now, peak);
        outcomes.push(outcome);
        this.options.onOutcome?.(outcome);
      }
    };

    const workers = Math.min(this.maxConcurrency, queue.length);
    await Promise.all(Array.from({ length: workers }, () => worker()));

    return {
      outcomes,
      order: rotation,
      deferred,
      durationMs: now() - startedAt,
      peakConcurrency: peak.value,
    };
  }

  /**
   * Run rounds until `shouldContinue` says otherwise. Kept here rather than in
   * the caller so the "check between rounds, not between ticks" rule has one
   * home.
   */
  async runRounds(
    shouldContinue: (round: number, report: RoundReport<T>) => boolean,
    maxRounds = Infinity,
  ): Promise<RoundReport<T>[]> {
    const reports: RoundReport<T>[] = [];
    for (let round = 0; round < maxRounds; round++) {
      if (this.options.stopping?.() === true) break;
      const report = await this.runRound();
      reports.push(report);
      if (!shouldContinue(round, report)) break;
    }
    return reports;
  }

  /** The ready queue for one round: eligible agents, deduped, freshly shuffled. */
  private rotation(): readonly AgentId[] {
    const unique: AgentId[] = [];
    const seen = new Set<AgentId>();
    for (const agentId of this.options.agents()) {
      if (seen.has(agentId)) continue;
      seen.add(agentId);
      unique.push(agentId);
    }
    // Shuffled per round rather than once at construction: a single shuffle is
    // still a fixed ordering, and a fixed ordering is exactly what hands the
    // same agent first pick of contested work every time.
    return this.options.rng.shuffle(unique);
  }

  private async runOne(
    agentId: AgentId,
    now: () => number,
    peak: { value: number },
  ): Promise<TickOutcome<T>> {
    this.inFlight.add(agentId);
    peak.value = Math.max(peak.value, this.inFlight.size);
    const startedAt = now();
    try {
      const result = await this.options.tick(agentId);
      return { agentId, result, durationMs: now() - startedAt };
    } catch (error) {
      // A thrown tick is a bug rather than a world event, but it is recorded as a
      // failure value so the round completes and the bug is visible afterwards.
      return {
        agentId,
        result: fail<T>('INTERNAL', `the tick threw: ${describeError(error)}`),
        durationMs: now() - startedAt,
      };
    } finally {
      this.inFlight.delete(agentId);
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Successful tick values from a round, for callers that only want the reports. */
export function successes<T>(report: RoundReport<T>): T[] {
  const out: T[] = [];
  for (const outcome of report.outcomes) {
    if (outcome.result.ok) out.push(outcome.result.value);
  }
  return out;
}
