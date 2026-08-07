/**
 * Needs: the pressure that makes agents act without being told to.
 *
 * Two decisions matter here.
 *
 * **Needs decay against world time, not tick count** (ADR-0011). A per-tick
 * decay would make an agent that the scheduler happens to run less often
 * effectively immortal, and would let hunger depend on CPU load. Decay is
 * therefore a function of elapsed Minecraft ticks.
 *
 * **Some needs are observed rather than decayed.** Shelter and safety are facts
 * about the agent's surroundings — being indoors is not something that wears
 * off — so observation sets them directly.
 */

import { clamp01, NEEDS, type Agent, type NeedKind, type Needs } from './agent.ts';
import { TICKS_PER_DAY } from '../persistence/repositories/simulation.ts';
import type { DayPhase } from '../core/world.ts';

/** Days of world time for a need to fall from full to empty, when it decays. */
const DAYS_TO_EMPTY: Readonly<Record<NeedKind, number | null>> = {
  food: 2.5,
  energy: 1.5,
  social: 4,
  // Observed from surroundings rather than decayed.
  shelter: null,
  safety: null,
};

/** Below this, a need is pressing enough to compete for the agent's attention. */
export const NEED_CONCERN = 0.45;
/** Below this, a need overrides essentially anything else. */
export const NEED_CRITICAL = 0.2;

/**
 * How much each need matters when it is short. Food and safety dominate because
 * they kill; social is real but never urgent.
 */
const NEED_WEIGHT: Readonly<Record<NeedKind, number>> = {
  food: 1.0,
  safety: 0.95,
  shelter: 0.8,
  energy: 0.6,
  social: 0.35,
};

export interface NeedContext {
  /** Elapsed world ticks since this agent's needs were last updated. */
  readonly elapsedTicks: number;
  readonly phase: DayPhase;
  readonly isDay: boolean;
  /** Whether the agent is currently under cover. */
  readonly sheltered: boolean;
  /** Hostile entities within sight. */
  readonly hostilesNearby: number;
  /** Other agents within sight — company, and safety in numbers. */
  readonly companionsNearby: number;
  /** Whether the agent is resting this tick. */
  readonly resting: boolean;
}

/**
 * Advance needs by elapsed world time and fold in what was observed.
 *
 * Pure: takes needs and context, returns new needs.
 */
export function updateNeeds(needs: Needs, context: NeedContext): Needs {
  const elapsedDays = Math.max(0, context.elapsedTicks) / TICKS_PER_DAY;
  const next: Needs = { ...needs };

  for (const kind of NEEDS) {
    const days = DAYS_TO_EMPTY[kind];
    if (days === null) continue;
    next[kind] = clamp01(needs[kind] - elapsedDays / days);
  }

  // Resting restores energy several times faster than it drains.
  if (context.resting) {
    next.energy = clamp01(next.energy + (elapsedDays / DAYS_TO_EMPTY.energy!) * 4);
  }

  // Shelter is a fact about where the agent is standing. It matters most at
  // night, which is what turns dusk into a deadline rather than a mood.
  next.shelter = context.sheltered ? 1 : context.isDay ? 0.5 : 0.1;

  // Safety: darkness and hostiles erode it; cover and company restore it.
  let safety = context.isDay ? 0.85 : 0.4;
  if (context.sheltered) safety += 0.35;
  safety -= context.hostilesNearby * 0.3;
  safety += Math.min(0.2, context.companionsNearby * 0.1);
  next.safety = clamp01(safety);

  // Company satisfies the social need directly, so agents have a reason to be
  // near each other beyond coordination.
  if (context.companionsNearby > 0) {
    next.social = clamp01(next.social + elapsedDays * 2);
  }

  return next;
}

export interface NeedPressure {
  readonly kind: NeedKind;
  readonly value: number;
  /** 0..1. How loudly this need is asking to be dealt with. */
  readonly urgency: number;
  readonly critical: boolean;
}

/** Needs worth acting on, most urgent first. */
export function needPressures(needs: Needs): NeedPressure[] {
  return NEEDS.map((kind) => {
    const value = clamp01(needs[kind]);
    // Urgency rises non-linearly: a need at 0.1 is far more than twice as
    // pressing as one at 0.2, which is what makes crises actually interrupt.
    const shortfall = Math.max(0, NEED_CONCERN - value) / NEED_CONCERN;
    return {
      kind,
      value,
      urgency: clamp01(shortfall * shortfall * NEED_WEIGHT[kind]),
      critical: value <= NEED_CRITICAL,
    };
  })
    .filter((pressure) => pressure.urgency > 0)
    .sort((a, b) => b.urgency - a.urgency);
}

/** The single most pressing need, or null when the agent is comfortable. */
export function mostPressingNeed(needs: Needs): NeedPressure | null {
  return needPressures(needs)[0] ?? null;
}

export function hasCriticalNeed(needs: Needs): boolean {
  return NEEDS.some((kind) => needs[kind] <= NEED_CRITICAL);
}

/**
 * Whether dusk is close enough that an agent without shelter should stop what
 * it is doing. This is the mechanism behind "night approaching + no shelter →
 * seek shelter" from requirement 7.
 */
export function shelterDeadlineApproaching(phase: DayPhase, needs: Needs): boolean {
  if (needs.shelter > 0.7) return false;
  return phase === 'dusk' || phase === 'night';
}

/** A one-line summary for the CLI and for prompts. */
export function describeNeeds(needs: Needs): string {
  return NEEDS.map((kind) => `${kind} ${Math.round(clamp01(needs[kind]) * 100)}%`).join(', ');
}

/** Needs an agent should have on spawn, given its personality. Slight variation
 *  so five agents don't hit the same crisis on the same tick. */
export function startingNeeds(base: Needs, jitter: number): Needs {
  const out: Needs = { ...base };
  for (const kind of NEEDS) {
    out[kind] = clamp01(base[kind] + jitter);
  }
  return out;
}

export function agentIsHungry(agent: Agent): boolean {
  return agent.needs.food <= NEED_CONCERN;
}
