/**
 * A deterministic voxel world, generated from a seed.
 *
 * This exists so the whole simulation is testable without a Minecraft server.
 * It is not a toy: terrain has elevation, water, forests and buried ore, so
 * agents genuinely have to survey, travel and fail to find things. A test that
 * passes here exercises the same code paths a real run does.
 *
 * Blocks are generated lazily from noise; only mutations are stored, so an
 * unbounded world costs memory proportional to what agents actually changed.
 */

import {
  positionKey,
  type Position,
  type ResourceKind,
  type SurfaceKind,
} from '../../core/world.ts';

export interface FakeBlock {
  readonly surface: SurfaceKind;
  readonly yields: ResourceKind | null;
  readonly solid: boolean;
}

export const AIR: FakeBlock = { surface: 'unknown', yields: null, solid: false };
const WATER: FakeBlock = { surface: 'water', yields: null, solid: false };
const GRASS: FakeBlock = { surface: 'vegetation', yields: 'fiber', solid: true };
const SOIL: FakeBlock = { surface: 'soil', yields: 'soil', solid: true };
const SAND: FakeBlock = { surface: 'sand', yields: 'sand', solid: true };
const STONE: FakeBlock = { surface: 'stone', yields: 'stone', solid: true };
const SNOW: FakeBlock = { surface: 'snow', yields: null, solid: true };
const WOOD: FakeBlock = { surface: 'wood', yields: 'wood', solid: true };
const LEAVES: FakeBlock = { surface: 'vegetation', yields: 'fiber', solid: true };
const COAL: FakeBlock = { surface: 'stone', yields: 'coal', solid: true };
const IRON: FakeBlock = { surface: 'stone', yields: 'iron', solid: true };
/** Food grows on the surface in clumps — berry bushes, effectively. */
const FORAGE: FakeBlock = { surface: 'vegetation', yields: 'food', solid: true };

export const SEA_LEVEL = 62;
export const MIN_ELEVATION = 0;
export const MAX_ELEVATION = 200;

/**
 * Stable hash of a coordinate pair plus a salt, in [0, 1).
 *
 * Every XOR is followed by `>>> 0`. JavaScript's `^` yields a *signed* 32-bit
 * integer, so without that coercion a set top bit makes the result negative and
 * the hash spans -0.5..0.5 with a mean of 0 rather than 0.5 — which silently
 * sinks the terrain below sea level and suppresses trees and ore entirely.
 */
function hash2(x: number, z: number, salt: number): number {
  let h =
    (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(z | 0, 0x165667b1) ^ Math.imul(salt, 0x9e3779b1)) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h = (h ^ (h >>> 12)) >>> 0;
  h = Math.imul(h, 0x297a2d39) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h / 4294967296;
}

function hash3(x: number, y: number, z: number, salt: number): number {
  return hash2(Math.imul(x | 0, 31) + (y | 0), z, salt);
}

/** Smooth interpolation between lattice points — value noise. */
function smoothNoise(x: number, z: number, salt: number): number {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const fx = x - x0;
  const fz = z - z0;
  // Smoothstep, so terrain has no visible lattice creases.
  const sx = fx * fx * (3 - 2 * fx);
  const sz = fz * fz * (3 - 2 * fz);

  const n00 = hash2(x0, z0, salt);
  const n10 = hash2(x0 + 1, z0, salt);
  const n01 = hash2(x0, z0 + 1, salt);
  const n11 = hash2(x0 + 1, z0 + 1, salt);

  const top = n00 + (n10 - n00) * sx;
  const bottom = n01 + (n11 - n01) * sx;
  return top + (bottom - top) * sz;
}

export interface FakeWorldOptions {
  readonly seed?: number;
  /** Terrain relief in blocks. 0 makes a flat plain, useful for focused tests. */
  readonly amplitude?: number;
}

export class FakeWorld {
  private readonly seed: number;
  private readonly amplitude: number;
  /** Only mutations are stored; everything else is generated on demand. */
  private readonly overrides = new Map<string, FakeBlock>();
  /** Cached surface heights, since surveys hit the same columns repeatedly. */
  private readonly heightCache = new Map<string, number>();

  constructor(options: FakeWorldOptions = {}) {
    this.seed = options.seed ?? 1;
    this.amplitude = options.amplitude ?? 12;
  }

  /** Ground elevation of a column, ignoring trees and mutations. */
  terrainHeight(x: number, z: number): number {
    const key = `${Math.floor(x)},${Math.floor(z)}`;
    const cached = this.heightCache.get(key);
    if (cached !== undefined) return cached;

    // Three weighted octaves. Weights sum to 1, so the mean stays at 0.5 —
    // a single coarse octave lets a few hundred blocks span only a handful of
    // lattice cells, and whatever those cells happen to be skews the whole
    // area's elevation (which once put most of the world under water).
    const h =
      0.5 * smoothNoise(x / 64, z / 64, this.seed) +
      0.35 * smoothNoise(x / 24, z / 24, this.seed + 977) +
      0.15 * smoothNoise(x / 8, z / 8, this.seed + 1861);
    // Baseline sits above sea level so land is the default and water is a
    // feature, not the other way round.
    const height = Math.round(SEA_LEVEL + 5 + (h - 0.5) * this.amplitude * 2);
    const clamped = Math.max(MIN_ELEVATION + 1, Math.min(MAX_ELEVATION - 1, height));
    this.heightCache.set(key, clamped);
    return clamped;
  }

  /** Elevation of the highest solid block, accounting for mutations and trees. */
  surfaceHeight(x: number, z: number): number {
    const ground = this.terrainHeight(x, z);
    // Scan upward for built structures and trees, downward for excavation.
    for (let y = Math.min(MAX_ELEVATION - 1, ground + 24); y > MIN_ELEVATION; y--) {
      if (this.blockAt({ x: Math.floor(x), y, z: Math.floor(z) }).solid) return y;
    }
    return MIN_ELEVATION;
  }

  blockAt(position: Position): FakeBlock {
    const p = {
      x: Math.floor(position.x),
      y: Math.floor(position.y),
      z: Math.floor(position.z),
    };
    const override = this.overrides.get(positionKey(p));
    if (override !== undefined) return override;
    return this.generate(p);
  }

  setBlock(position: Position, block: FakeBlock): void {
    const p = {
      x: Math.floor(position.x),
      y: Math.floor(position.y),
      z: Math.floor(position.z),
    };
    this.overrides.set(positionKey(p), block);
  }

  removeBlock(position: Position): void {
    this.setBlock(position, AIR);
  }

  /** How many blocks have been changed from the generated world. */
  mutationCount(): number {
    return this.overrides.size;
  }

  private generate(p: Position): FakeBlock {
    const { x, y, z } = p;
    if (y <= MIN_ELEVATION) return STONE;
    if (y >= MAX_ELEVATION) return AIR;

    const ground = this.terrainHeight(x, z);

    if (y > ground) {
      // Above ground: water fills basins, trees rise from forest columns.
      if (y <= SEA_LEVEL && ground < SEA_LEVEL) return WATER;
      const tree = this.treeAt(x, z);
      if (tree !== null && y <= ground + tree.height) {
        return y > ground + tree.height - 2 ? LEAVES : WOOD;
      }
      return AIR;
    }

    if (y === ground) {
      if (ground < SEA_LEVEL) return SAND;
      if (ground <= SEA_LEVEL + 1) return SAND;
      if (ground > SEA_LEVEL + 28) return SNOW;
      // Forage grows in scattered clumps on grassland — common enough that a
      // forager can feed themselves, sparse enough that they have to look.
      if (hash2(x, z, this.seed + 5501) > 0.88) return FORAGE;
      return GRASS;
    }

    if (y >= ground - 3) return ground < SEA_LEVEL ? SAND : SOIL;

    // Underground: ore in veins, deeper for iron than coal.
    if (y < 48 && hash3(x, y, z, this.seed + 7717) > 0.988) return IRON;
    if (y < 58 && hash3(x, y, z, this.seed + 3313) > 0.982) return COAL;
    return STONE;
  }

  /** Whether a tree grows in this column, and how tall. */
  private treeAt(x: number, z: number): { height: number } | null {
    const ground = this.terrainHeight(x, z);
    // Trees need dry, non-alpine ground. The band is generous on purpose: a
    // narrow one can miss the terrain's actual elevation range entirely and
    // produce a world with no forest at all.
    if (ground <= SEA_LEVEL || ground > SEA_LEVEL + 26) return null;

    // Forest density varies by area, so woodland is clustered rather than even —
    // which means agents actually have to find it.
    const density = smoothNoise(x / 32, z / 32, this.seed + 1231);
    if (density < 0.55) return null;
    if (hash2(x, z, this.seed + 4409) > 0.22) return null;

    return { height: 4 + Math.floor(hash2(x, z, this.seed + 8821) * 3) };
  }
}
