/**
 * Seeded pseudorandom generator.
 *
 * Worldloom uses this rather than Math.random so that a run's structural
 * choices — agent tick rotation, tie-breaking between equally good goals,
 * sampling positions to verify — are reproducible from the config seed
 * (requirement 31). Model responses aren't reproducible, but everything
 * around them should be.
 */

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** Uniform element. Throws on an empty array — callers should guard. */
  pick<T>(items: readonly T[]): T;
  /** New array, Fisher–Yates shuffled. Does not mutate the input. */
  shuffle<T>(items: readonly T[]): T[];
  /** True with the given probability. */
  chance(probability: number): boolean;
  /** A derived generator, so subsystems don't consume each other's sequence. */
  fork(label: string): Rng;
}

/** mulberry32: small, fast, and good enough for simulation tie-breaking. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a, used to turn a fork label into a seed offset. */
function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function createRng(seed: number): Rng {
  const next = mulberry32(seed);

  const rng: Rng = {
    next,

    int(min: number, max: number): number {
      if (max < min) throw new Error(`rng.int: max (${max}) < min (${min})`);
      return min + Math.floor(next() * (max - min + 1));
    },

    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new Error('rng.pick: empty array');
      // Non-null assertion is sound: index is bounded by the length check above.
      return items[Math.floor(next() * items.length)]!;
    },

    shuffle<T>(items: readonly T[]): T[] {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    },

    chance(probability: number): boolean {
      return next() < probability;
    },

    fork(label: string): Rng {
      return createRng((seed ^ hashString(label)) >>> 0);
    },
  };

  return rng;
}
