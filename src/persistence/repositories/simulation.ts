/**
 * Simulation-level state: the world clock and run metadata.
 *
 * The clock is the interesting part. Minecraft's `time_ticks` wraps every
 * 24000 ticks, so a monotonic total has to be maintained here and persisted —
 * otherwise a restart would put the civilization back on day 0 (ADR-0011).
 */

import { numberCol, requireRow, textCol, type Database } from '../db.ts';
import type { DayPhase, Weather, WorldTime } from '../../core/world.ts';

/** Minecraft ticks per full day/night cycle. */
export const TICKS_PER_DAY = 24_000;

export type SimulationStatus = 'running' | 'stopped' | 'finished';

export interface SimulationState {
  readonly scenario: string;
  readonly seed: number;
  readonly startedAt: number;
  readonly worldTicks: number;
  readonly worldDay: number;
  readonly lastRawTicks: number;
  readonly weather: Weather;
  readonly status: SimulationStatus;
}

/** Which part of the day a raw tick count falls in. */
export function phaseOf(rawTicks: number): DayPhase {
  const t = ((rawTicks % TICKS_PER_DAY) + TICKS_PER_DAY) % TICKS_PER_DAY;
  // Minecraft: 0 sunrise, 6000 noon, 12000 sunset, 18000 midnight.
  if (t < 1_000) return 'dawn';
  if (t < 11_000) return 'day';
  if (t < 13_000) return 'dusk';
  return 'night';
}

export function isDaylight(rawTicks: number): boolean {
  const phase = phaseOf(rawTicks);
  return phase === 'day' || phase === 'dawn';
}

export class SimulationRepository {
  constructor(private readonly db: Database) {}

  /** Create the singleton row if absent. Returns the state either way. */
  initialise(scenario: string, seed: number, now = Date.now()): SimulationState {
    this.db
      .prepare(
        `INSERT INTO simulation (id, scenario, seed, started_at, world_ticks, world_day,
                                 last_raw_ticks, weather, status)
         VALUES (1, ?, ?, ?, 0, 0, 0, 'clear', 'running')
         ON CONFLICT (id) DO NOTHING`,
      )
      .run(scenario, seed, now);
    return this.get();
  }

  exists(): boolean {
    return this.db.prepare('SELECT 1 FROM simulation WHERE id = 1').get() !== undefined;
  }

  get(): SimulationState {
    const row = requireRow(
      this.db.prepare('SELECT * FROM simulation WHERE id = 1').get(),
      'simulation state (not initialised)',
    );
    return {
      scenario: textCol(row, 'scenario'),
      seed: numberCol(row, 'seed'),
      startedAt: numberCol(row, 'started_at'),
      worldTicks: numberCol(row, 'world_ticks'),
      worldDay: numberCol(row, 'world_day'),
      lastRawTicks: numberCol(row, 'last_raw_ticks'),
      weather: textCol(row, 'weather') as Weather,
      status: textCol(row, 'status') as SimulationStatus,
    };
  }

  /**
   * Fold a fresh observation of the world clock into monotonic time.
   *
   * Minecraft's clock wraps, and it can also be moved backwards deliberately
   * (`set_time`, which scenarios use to accelerate a demo). A decrease is
   * therefore read as "a new day began", advancing the total by the remainder
   * of the previous day plus the new offset. A forward jump inside the same day
   * is added directly.
   */
  advanceClock(rawTicks: number, weather: Weather): WorldTime {
    const state = this.get();
    const previousRaw = state.lastRawTicks;

    let elapsed: number;
    let day = state.worldDay;
    if (rawTicks >= previousRaw) {
      elapsed = rawTicks - previousRaw;
    } else {
      // Wrapped (or was set backwards): finish the old day, then add the offset.
      elapsed = TICKS_PER_DAY - previousRaw + rawTicks;
      day += 1;
    }

    const worldTicks = state.worldTicks + elapsed;
    // A single elapsed span can cover more than one day if the caller was slow
    // or time was scaled hard; derive the day from the total to stay consistent.
    const derivedDay = Math.max(day, Math.floor(worldTicks / TICKS_PER_DAY));

    this.db
      .prepare(
        `UPDATE simulation
            SET world_ticks = ?, world_day = ?, last_raw_ticks = ?, weather = ?
          WHERE id = 1`,
      )
      .run(worldTicks, derivedDay, rawTicks, weather);

    return {
      totalTicks: worldTicks,
      day: derivedDay,
      phase: phaseOf(rawTicks),
      isDay: isDaylight(rawTicks),
      weather,
    };
  }

  /** Current clock without consulting the environment. */
  currentTime(): WorldTime {
    const state = this.get();
    return {
      totalTicks: state.worldTicks,
      day: state.worldDay,
      phase: phaseOf(state.lastRawTicks),
      isDay: isDaylight(state.lastRawTicks),
      weather: state.weather,
    };
  }

  setStatus(status: SimulationStatus): void {
    this.db.prepare('UPDATE simulation SET status = ? WHERE id = 1').run(status);
  }
}
