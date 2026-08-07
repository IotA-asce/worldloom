/**
 * Spatial and material primitives shared by the whole simulation.
 *
 * Everything here is environment-agnostic on purpose. `oak_log` and
 * `cobblestone` are Minecraft vocabulary and live in the adapter; the core
 * reasons about `wood` and `stone`. A Godot or Webots adapter maps its own
 * materials onto the same small vocabulary, which is what keeps agent logic
 * portable (ADR: see docs/architecture.md §1).
 */

export interface Position {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Axis-aligned box, inclusive of both corners. The unit of reservation. */
export interface Region {
  readonly min: Position;
  readonly max: Position;
}

/**
 * Resources agents gather, spend, and trade. Abstract categories rather than
 * item ids — the ledger counts `wood`, and the adapter decides that oak logs
 * and spruce logs both credit it.
 */
export const RESOURCE_KINDS = [
  'wood',
  'stone',
  'soil',
  'sand',
  'coal',
  'iron',
  'food',
  'fiber',
] as const;

export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export function isResourceKind(value: string): value is ResourceKind {
  return (RESOURCE_KINDS as readonly string[]).includes(value);
}

/** A count of resources. Absent keys mean zero. */
export type ResourceBundle = Partial<Record<ResourceKind, number>>;

/**
 * Structural materials a blueprint can call for. Distinct from ResourceKind
 * because building consumes resources to produce placed material: `timber`
 * costs `wood`, `masonry` costs `stone`.
 */
export const BUILD_MATERIALS = [
  'timber',
  'masonry',
  'packed_soil',
  'thatch',
  'glass',
  'light',
  'door',
  'empty',
] as const;

export type BuildMaterial = (typeof BUILD_MATERIALS)[number];

/** What a build material costs from the ledger, per block placed. */
export const MATERIAL_COST: Readonly<Record<BuildMaterial, ResourceBundle>> = {
  timber: { wood: 1 },
  masonry: { stone: 1 },
  packed_soil: { soil: 1 },
  thatch: { fiber: 1 },
  glass: { sand: 1 },
  light: { coal: 1, wood: 1 },
  door: { wood: 2 },
  // Clearing space costs nothing and yields nothing we bother to track.
  empty: {},
};

/** Normalised surface classification returned by a terrain survey. */
export const SURFACE_KINDS = [
  'water',
  'stone',
  'soil',
  'sand',
  'vegetation',
  'wood',
  'snow',
  'unknown',
] as const;

export type SurfaceKind = (typeof SURFACE_KINDS)[number];

export interface SurveyCell {
  readonly x: number;
  readonly z: number;
  /** Elevation of the highest solid surface. */
  readonly y: number;
  readonly surface: SurfaceKind;
}

export interface TerrainSurvey {
  readonly region: Region;
  /** Spacing between sampled cells, in blocks. */
  readonly resolution: number;
  readonly cells: readonly SurveyCell[];
}

export const DAY_PHASES = ['dawn', 'day', 'dusk', 'night'] as const;
export type DayPhase = (typeof DAY_PHASES)[number];

export type Weather = 'clear' | 'rain' | 'thunder';

export interface WorldTime {
  /** Monotonic across days, so elapsed time is a subtraction (ADR-0011). */
  readonly totalTicks: number;
  readonly day: number;
  readonly phase: DayPhase;
  readonly isDay: boolean;
  readonly weather: Weather;
}

/** One block of a blueprint, positioned relative to the structure's origin. */
export interface BlueprintBlock {
  readonly dx: number;
  readonly dy: number;
  readonly dz: number;
  readonly material: BuildMaterial;
}

export interface Blueprint {
  readonly name: string;
  /** Extent in blocks, used for site selection and reservation sizing. */
  readonly size: { readonly width: number; readonly height: number; readonly depth: number };
  readonly blocks: readonly BlueprintBlock[];
}

// ── Position helpers ────────────────────────────────────────────────────────

export function position(x: number, y: number, z: number): Position {
  return { x, y, z };
}

export function samePosition(a: Position, b: Position): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

/** Straight-line distance. */
export function distance(a: Position, b: Position): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

/**
 * Distance ignoring elevation. Usually the right measure for travel decisions
 * and "is this nearby" checks, since a block directly overhead is not a
 * two-block walk.
 */
export function horizontalDistance(a: Position, b: Position): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2);
}

export function floorPosition(p: Position): Position {
  return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
}

export function formatPosition(p: Position): string {
  const round = (n: number) => (Number.isInteger(n) ? n : Math.round(n));
  return `(${round(p.x)}, ${round(p.y)}, ${round(p.z)})`;
}

/** Stable key for maps and sets keyed by block position. */
export function positionKey(p: Position): string {
  return `${p.x},${p.y},${p.z}`;
}

// ── Region helpers ──────────────────────────────────────────────────────────

/** Build a region from any two opposite corners, normalising the bounds. */
export function region(a: Position, b: Position): Region {
  return {
    min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) },
    max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(a.z, b.z) },
  };
}

export function regionContains(r: Region, p: Position): boolean {
  return (
    p.x >= r.min.x && p.x <= r.max.x &&
    p.y >= r.min.y && p.y <= r.max.y &&
    p.z >= r.min.z && p.z <= r.max.z
  );
}

/** Whether two regions share any block. The reservation conflict test (ADR-0005). */
export function regionsOverlap(a: Region, b: Region): boolean {
  return (
    a.min.x <= b.max.x && a.max.x >= b.min.x &&
    a.min.y <= b.max.y && a.max.y >= b.min.y &&
    a.min.z <= b.max.z && a.max.z >= b.min.z
  );
}

/** Block count, inclusive of both corners. */
export function regionVolume(r: Region): number {
  return (
    (r.max.x - r.min.x + 1) *
    (r.max.y - r.min.y + 1) *
    (r.max.z - r.min.z + 1)
  );
}

export function regionCenter(r: Region): Position {
  return {
    x: (r.min.x + r.max.x) / 2,
    y: (r.min.y + r.max.y) / 2,
    z: (r.min.z + r.max.z) / 2,
  };
}

/** Grow a region outward by `margin` on every axis. */
export function expandRegion(r: Region, margin: number): Region {
  return {
    min: { x: r.min.x - margin, y: r.min.y - margin, z: r.min.z - margin },
    max: { x: r.max.x + margin, y: r.max.y + margin, z: r.max.z + margin },
  };
}

export function formatRegion(r: Region): string {
  return `${formatPosition(r.min)}..${formatPosition(r.max)}`;
}

/** Every block position in a region. Callers must bound the volume first. */
export function* regionPositions(r: Region): Generator<Position> {
  for (let x = r.min.x; x <= r.max.x; x++) {
    for (let y = r.min.y; y <= r.max.y; y++) {
      for (let z = r.min.z; z <= r.max.z; z++) {
        yield { x, y, z };
      }
    }
  }
}

/** The region a blueprint occupies once anchored at `origin`. */
export function blueprintRegion(blueprint: Blueprint, origin: Position): Region {
  if (blueprint.blocks.length === 0) {
    return { min: origin, max: origin };
  }
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const block of blueprint.blocks) {
    minX = Math.min(minX, block.dx); maxX = Math.max(maxX, block.dx);
    minY = Math.min(minY, block.dy); maxY = Math.max(maxY, block.dy);
    minZ = Math.min(minZ, block.dz); maxZ = Math.max(maxZ, block.dz);
  }
  return {
    min: { x: origin.x + minX, y: origin.y + minY, z: origin.z + minZ },
    max: { x: origin.x + maxX, y: origin.y + maxY, z: origin.z + maxZ },
  };
}

// ── Resource bundle helpers ─────────────────────────────────────────────────

export function bundleGet(bundle: ResourceBundle, kind: ResourceKind): number {
  return bundle[kind] ?? 0;
}

export function bundleAdd(a: ResourceBundle, b: ResourceBundle): ResourceBundle {
  const out: ResourceBundle = { ...a };
  for (const kind of RESOURCE_KINDS) {
    const sum = bundleGet(a, kind) + bundleGet(b, kind);
    if (sum !== 0) out[kind] = sum;
  }
  return out;
}

export function bundleScale(bundle: ResourceBundle, factor: number): ResourceBundle {
  const out: ResourceBundle = {};
  for (const kind of RESOURCE_KINDS) {
    const value = bundleGet(bundle, kind) * factor;
    if (value !== 0) out[kind] = value;
  }
  return out;
}

export function bundleIsEmpty(bundle: ResourceBundle): boolean {
  return RESOURCE_KINDS.every((kind) => bundleGet(bundle, kind) === 0);
}

/** What `have` is short of `needed`; empty when the requirement is met. */
export function bundleShortfall(needed: ResourceBundle, have: ResourceBundle): ResourceBundle {
  const out: ResourceBundle = {};
  for (const kind of RESOURCE_KINDS) {
    const missing = bundleGet(needed, kind) - bundleGet(have, kind);
    if (missing > 0) out[kind] = missing;
  }
  return out;
}

export function formatBundle(bundle: ResourceBundle): string {
  const parts = RESOURCE_KINDS
    .filter((kind) => bundleGet(bundle, kind) !== 0)
    .map((kind) => `${bundleGet(bundle, kind)} ${kind}`);
  return parts.length > 0 ? parts.join(', ') : 'nothing';
}

/** Total resource cost of building a blueprint. */
export function blueprintCost(blueprint: Blueprint): ResourceBundle {
  let total: ResourceBundle = {};
  for (const block of blueprint.blocks) {
    total = bundleAdd(total, MATERIAL_COST[block.material]);
  }
  return total;
}
