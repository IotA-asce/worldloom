/**
 * Local terrain-following movement, shared by every environment adapter.
 *
 * Neither environment has a pathfinder — `minecraft-mcp`'s `move_to` is
 * velocity steering rather than routing (constraint C4). A straight line into
 * natural terrain is blocked almost immediately, which would make agents
 * effectively immobile on any hillside.
 *
 * So this does the smallest honest thing: at each block, step toward the
 * destination, and if that step is too steep, try stepping slightly around it.
 * The agent can walk around a boulder; it still cannot walk through a cliff.
 * That distinction is what keeps logical embodiment truthful (ADR-0003).
 *
 * A proper pathfinder is the obvious later improvement; this is deliberately
 * the cheap version that makes terrain traversable without pretending.
 */

import { horizontalDistance, type Position } from '../core/world.ts';

/**
 * Ground level at a column: the elevation an agent's feet would rest at.
 * Returns null where the column is unknown or unwalkable (water, void).
 */
export type HeightAt = (x: number, z: number) => number | null;

export interface TraversalOptions {
  /** Blocks the agent can climb in one step. */
  readonly maxStepUp?: number;
  /** Blocks the agent can drop in one step without harm. */
  readonly maxStepDown?: number;
  /** How far sideways it may deviate to get around an obstacle. */
  readonly maxSideStep?: number;
  /** Safety bound on the walk, so a pathological case can't spin. */
  readonly maxSteps?: number;
}

export interface TraversalResult {
  /** Where the agent ended up, standing on the ground. */
  readonly to: Position;
  readonly distance: number;
  readonly arrived: boolean;
  /** Set when the agent could not take a single step. */
  readonly blockedAt: Position | null;
}

const DEFAULTS = {
  // A Minecraft player steps up one block and drops several safely.
  maxStepUp: 1,
  maxStepDown: 4,
  maxSideStep: 2,
  maxSteps: 256,
} as const;

/** How close counts as arrival. */
export const ARRIVAL_TOLERANCE = 1.5;

export function traverse(
  from: Position,
  to: Position,
  heightAt: HeightAt,
  options: TraversalOptions = {},
): TraversalResult {
  const maxStepUp = options.maxStepUp ?? DEFAULTS.maxStepUp;
  const maxStepDown = options.maxStepDown ?? DEFAULTS.maxStepDown;
  const maxSideStep = options.maxSideStep ?? DEFAULTS.maxSideStep;
  const maxSteps = options.maxSteps ?? DEFAULTS.maxSteps;

  let current = from;
  let remaining = horizontalDistance(current, to);
  if (remaining <= ARRIVAL_TOLERANCE) {
    return { to: from, distance: 0, arrived: true, blockedAt: null };
  }

  for (let step = 0; step < maxSteps; step++) {
    const next = stepToward(current, to, heightAt, { maxStepUp, maxStepDown, maxSideStep });

    if (next === null) {
      const travelled = horizontalDistance(from, current);
      return {
        to: current,
        distance: travelled,
        arrived: false,
        // Only report a blocking position when nothing at all was achieved;
        // otherwise the caller should treat this as partial progress.
        blockedAt: travelled < 1 ? aheadOf(current, to) : null,
      };
    }

    current = next;
    const closer = horizontalDistance(current, to);
    // Guard against oscillating between two cells that each look like progress.
    if (closer >= remaining && step > 0) {
      return {
        to: current,
        distance: horizontalDistance(from, current),
        arrived: false,
        blockedAt: null,
      };
    }
    remaining = closer;

    if (remaining <= ARRIVAL_TOLERANCE) {
      return {
        to: current,
        distance: horizontalDistance(from, current),
        arrived: true,
        blockedAt: null,
      };
    }
  }

  return {
    to: current,
    distance: horizontalDistance(from, current),
    arrived: horizontalDistance(current, to) <= ARRIVAL_TOLERANCE,
    blockedAt: null,
  };
}

/**
 * One block's progress, deviating sideways if the direct step is too steep.
 * Candidates are ordered so the straightest walkable option wins.
 */
function stepToward(
  current: Position,
  to: Position,
  heightAt: HeightAt,
  limits: { maxStepUp: number; maxStepDown: number; maxSideStep: number },
): Position | null {
  const dx = to.x - current.x;
  const dz = to.z - current.z;
  const length = Math.max(1e-6, Math.hypot(dx, dz));
  const ux = dx / length;
  const uz = dz / length;

  // Perpendicular, for sidestepping around a rise.
  const px = -uz;
  const pz = ux;

  const candidates: { x: number; z: number }[] = [];
  for (let side = 0; side <= limits.maxSideStep; side++) {
    // Straight ahead first, then alternating left and right by `side`.
    const offsets = side === 0 ? [0] : [side, -side];
    for (const offset of offsets) {
      candidates.push({
        x: Math.round(current.x + ux + px * offset),
        z: Math.round(current.z + uz + pz * offset),
      });
    }
  }

  for (const candidate of candidates) {
    if (candidate.x === Math.round(current.x) && candidate.z === Math.round(current.z)) {
      continue;
    }
    const ground = heightAt(candidate.x, candidate.z);
    if (ground === null) continue;

    const standing = ground + 1;
    const climb = standing - current.y;
    if (climb > limits.maxStepUp || climb < -limits.maxStepDown) continue;

    return { x: candidate.x, y: standing, z: candidate.z };
  }

  return null;
}

/** The block the agent was trying to enter, for the failure's detail. */
function aheadOf(current: Position, to: Position): Position {
  const dx = to.x - current.x;
  const dz = to.z - current.z;
  const length = Math.max(1e-6, Math.hypot(dx, dz));
  return {
    x: Math.round(current.x + dx / length),
    y: current.y,
    z: Math.round(current.z + dz / length),
  };
}
