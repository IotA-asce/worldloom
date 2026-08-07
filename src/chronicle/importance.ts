/**
 * Stage 1 of the chronicle pipeline: deciding what a day is *about*
 * (ADR-0009 step 1).
 *
 * Two rules shape this file:
 *
 *  - **A busy day raises the bar.** A day with sixty events is not sixty times
 *    more interesting than a quiet one; it just has more noise. Selection
 *    therefore targets a roughly constant number of facts and climbs the
 *    importance threshold until it gets there. A quiet day stays at the base
 *    threshold and keeps everything above it, which is what makes the early
 *    days — when little is happening — readable at all.
 *  - **Some things are never routine.** A death or a founding survives any
 *    threshold, because "the day was too busy" is not a reason to omit it
 *    (`ALWAYS_NOTABLE`). That is the one rule the climbing threshold must not
 *    be able to break, so it is applied after selection and after the cap.
 *
 * Nothing here is a judgement call, so nothing here calls a model.
 */

import { ALWAYS_NOTABLE, isNotable, type EventType, type Importance, type WorldEvent } from '../events/types.ts';

/**
 * Coarse bands over the 0..1 importance scale, matching the comment on
 * `DEFAULT_IMPORTANCE`. Used for the threshold ladder and for explaining a
 * selection in a log line or a test failure.
 */
export const IMPORTANCE_BANDS = ['routine', 'memorable', 'notable', 'era_defining'] as const;
export type ImportanceBand = (typeof IMPORTANCE_BANDS)[number];

export function bandOf(importance: Importance): ImportanceBand {
  if (importance >= 0.9) return 'era_defining';
  if (importance >= 0.7) return 'notable';
  if (importance >= 0.4) return 'memorable';
  return 'routine';
}

/** The lowest importance a day's events are considered at. */
export const BASE_THRESHOLD = 0.5;

/** Roughly how many facts a day's entry should be built from. */
export const TARGET_FACTS = 12;

/**
 * Hard ceiling on facts per day. Above this the prose stops being a chronicle
 * and becomes a log dump — and the narration prompt stops being small
 * (requirement 29).
 */
export const MAX_FACTS = 24;

/**
 * The rungs the threshold may climb. Discrete rather than continuous so a day's
 * threshold is explainable ("day 6 was busy, so only notable events made it")
 * and stable under small changes in the ledger.
 */
export const THRESHOLD_LADDER: readonly number[] = [BASE_THRESHOLD, 0.6, 0.7, 0.8, 0.9, 1];

/**
 * Bookkeeping, not history. These have events so the ledger is complete, but
 * they describe the *record* rather than the world, and a chronicle that
 * narrates its own writing is a mirror facing a mirror.
 */
export const NOT_HISTORY: ReadonlySet<EventType> = new Set<EventType>([
  'day_began',
  'chronicle_entry_written',
]);

export interface SelectionOptions {
  /** Pin the threshold instead of deriving it from the day's volume. */
  readonly threshold?: number;
  readonly target?: number;
  readonly max?: number;
}

export interface DaySelection {
  readonly day: number;
  /** What the entry may describe, in ledger order. */
  readonly events: readonly WorldEvent[];
  /** The threshold that was applied, derived or pinned. */
  readonly threshold: number;
  /** How many of the day's events were eligible before thresholding. */
  readonly considered: number;
  /** Events kept only because their type is always notable. */
  readonly alwaysNotable: number;
}

/** Events of the day that could reach a chronicle at all. */
export function eligible(events: readonly WorldEvent[], day: number): WorldEvent[] {
  return events.filter((event) => event.day === day && !NOT_HISTORY.has(event.type));
}

/**
 * The threshold a day's volume justifies: the lowest rung that brings the
 * selection down to `target`. Always-notable events are counted but cannot be
 * excluded, so a day of nothing but deaths simply produces a long entry.
 */
export function thresholdFor(
  eligibleEvents: readonly WorldEvent[],
  options: SelectionOptions = {},
): number {
  if (options.threshold !== undefined) return options.threshold;

  const target = options.target ?? TARGET_FACTS;
  const unavoidable = eligibleEvents.filter((event) => ALWAYS_NOTABLE.has(event.type)).length;
  const optional = eligibleEvents.filter((event) => !ALWAYS_NOTABLE.has(event.type));

  for (const rung of THRESHOLD_LADDER) {
    const kept = optional.filter((event) => event.importance >= rung).length;
    if (unavoidable + kept <= target) return rung;
  }
  return THRESHOLD_LADDER[THRESHOLD_LADDER.length - 1] ?? BASE_THRESHOLD;
}

/**
 * The facts a day's entry is allowed to be built from.
 *
 * Ordering out is ledger order (`seq`), because a chronicle that reports the
 * evening before the morning is wrong even when every sentence is true.
 */
export function selectForDay(
  day: number,
  events: readonly WorldEvent[],
  options: SelectionOptions = {},
): DaySelection {
  const candidates = eligible(events, day);
  const threshold = thresholdFor(candidates, options);
  const max = options.max ?? MAX_FACTS;

  const selected = candidates.filter((event) => isNotable(event, threshold));

  // The cap is applied by dropping the *least* important optional events, never
  // an always-notable one — see the note at the top of this file.
  const unavoidable = selected.filter((event) => ALWAYS_NOTABLE.has(event.type));
  const optional = selected.filter((event) => !ALWAYS_NOTABLE.has(event.type));
  const room = Math.max(0, max - unavoidable.length);
  const trimmed =
    optional.length <= room
      ? optional
      : [...optional]
          .sort((a, b) => b.importance - a.importance || a.seq - b.seq)
          .slice(0, room);

  const kept = [...unavoidable, ...trimmed].sort((a, b) => a.seq - b.seq);

  return {
    day,
    events: kept,
    threshold,
    considered: candidates.length,
    alwaysNotable: unavoidable.length,
  };
}

/** One line explaining a selection, for logs and test failures. */
export function describeSelection(selection: DaySelection): string {
  return (
    `day ${selection.day}: ${selection.events.length} of ${selection.considered} events ` +
    `at importance >= ${selection.threshold} (${selection.alwaysNotable} always notable)`
  );
}
