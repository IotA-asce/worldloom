/**
 * The Minecraft vocabulary — the *only* place block ids appear.
 *
 * Worldloom's core speaks `wood` and `masonry`. This module translates, in both
 * directions, and nothing above `src/environment/` imports it. A test greps the
 * core tree to keep that true.
 */

import type { BuildMaterial, ResourceKind, SurfaceKind } from '../../core/world.ts';

/** Block ids that yield each resource when removed. Order matters only in that
 *  the first entry is used when we need a representative block. */
export const RESOURCE_BLOCKS: Readonly<Record<ResourceKind, readonly string[]>> = {
  wood: [
    'oak_log',
    'spruce_log',
    'birch_log',
    'jungle_log',
    'acacia_log',
    'dark_oak_log',
    'mangrove_log',
    'cherry_log',
    'pale_oak_log',
    // Worked wood yields wood too. Without these, `surfaceFromBlock` reports a
    // plank wall as `wood` while `resourceFromBlock` reports nothing — so an
    // agent perceives a timber building as a source of timber and is then told
    // there is none there. A live-server test caught exactly that.
    'oak_planks',
    'spruce_planks',
    'birch_planks',
    'jungle_planks',
    'acacia_planks',
    'dark_oak_planks',
    'oak_door',
    'oak_fence',
    'oak_stairs',
    'oak_slab',
  ],
  stone: [
    'stone',
    'cobblestone',
    'andesite',
    'diorite',
    'granite',
    'deepslate',
    'cobbled_deepslate',
    'tuff',
  ],
  soil: ['dirt', 'coarse_dirt', 'rooted_dirt', 'podzol', 'grass_block'],
  // Glass is included so a glazed structure can be dismantled back into sand.
  // Vanilla glass drops nothing, but Worldloom's ledger is an abstraction and a
  // one-way resource sink is worse than a small fidelity gap: resources should
  // not vanish permanently into a wall.
  sand: ['sand', 'red_sand', 'gravel', 'glass'],
  coal: ['coal_ore', 'deepslate_coal_ore'],
  iron: ['iron_ore', 'deepslate_iron_ore'],
  food: ['sweet_berry_bush', 'melon', 'pumpkin', 'wheat', 'carrots', 'potatoes', 'beetroots'],
  fiber: [
    'oak_leaves',
    'spruce_leaves',
    'birch_leaves',
    'jungle_leaves',
    'acacia_leaves',
    'dark_oak_leaves',
    'short_grass',
    'tall_grass',
    'fern',
    'large_fern',
    'sugar_cane',
    // Worked fibre, for the same reason as worked wood above: a thatch roof has
    // to be recoverable, or building is a one-way loss.
    'hay_block',
  ],
};

/** Reverse index, built once. */
const BLOCK_TO_RESOURCE = new Map<string, ResourceKind>();
for (const [resource, blocks] of Object.entries(RESOURCE_BLOCKS) as [ResourceKind, readonly string[]][]) {
  for (const block of blocks) {
    // First mapping wins: `grass_block` yields soil rather than fiber.
    if (!BLOCK_TO_RESOURCE.has(block)) BLOCK_TO_RESOURCE.set(block, resource);
  }
}

/** Surface classification for terrain reading. Broader than the resource map
 *  because plenty of blocks are terrain without being harvestable. */
const SURFACE_PATTERNS: readonly (readonly [RegExp, SurfaceKind])[] = [
  [/water|kelp|seagrass|bubble_column/, 'water'],
  [/_log$|_wood$|_stem$|_hyphae$|planks|_fence|_door|_stairs|_slab/, 'wood'],
  [/leaves|grass$|grass_block|fern|flower|sapling|moss|azalea|vine|bush|crop|wheat|sugar_cane|bamboo|mushroom/, 'vegetation'],
  [/snow|ice|packed_ice|blue_ice|powder_snow/, 'snow'],
  [/sand$|sandstone|gravel/, 'sand'],
  [/dirt|podzol|mud$|clay|farmland|soul_soil/, 'soil'],
  [/stone|deepslate|andesite|diorite|granite|tuff|basalt|blackstone|ore$|obsidian|bricks?$|calcite|netherrack/, 'stone'],
];

const NON_SOLID = new Set([
  'air',
  'cave_air',
  'void_air',
  'water',
  'lava',
  'torch',
  'wall_torch',
  'short_grass',
  'tall_grass',
  'fern',
  'snow',
  'vine',
  'sugar_cane',
  'sweet_berry_bush',
  'wheat',
  'carrots',
  'potatoes',
  'beetroots',
]);

export function isAir(block: string): boolean {
  return block === 'air' || block === 'cave_air' || block === 'void_air';
}

export function isSolid(block: string): boolean {
  return !isAir(block) && !NON_SOLID.has(block);
}

/** What removing this block yields, or null for terrain with no value. */
export function resourceFromBlock(block: string): ResourceKind | null {
  return BLOCK_TO_RESOURCE.get(block) ?? null;
}

export function surfaceFromBlock(block: string): SurfaceKind {
  if (isAir(block)) return 'unknown';
  for (const [pattern, surface] of SURFACE_PATTERNS) {
    if (pattern.test(block)) return surface;
  }
  return 'unknown';
}

/** What a build material is placed as. */
export const MATERIAL_BLOCK: Readonly<Record<BuildMaterial, string>> = {
  timber: 'oak_planks',
  masonry: 'cobblestone',
  packed_soil: 'dirt',
  thatch: 'hay_block',
  glass: 'glass',
  light: 'torch',
  door: 'oak_door',
  empty: 'air',
};

/** Blocks that count as a correct placement for a material. Verification is
 *  tolerant: a torch may end up as `wall_torch` depending on what it attached
 *  to, and that is a success, not a defect. */
export const MATERIAL_ACCEPTS: Readonly<Record<BuildMaterial, readonly string[]>> = {
  timber: ['oak_planks'],
  masonry: ['cobblestone'],
  packed_soil: ['dirt'],
  thatch: ['hay_block'],
  glass: ['glass'],
  light: ['torch', 'wall_torch'],
  door: ['oak_door'],
  empty: ['air', 'cave_air', 'void_air'],
};

export function materialMatches(material: BuildMaterial, block: string): boolean {
  return MATERIAL_ACCEPTS[material].includes(block);
}

/**
 * Vanilla caps a single `fill` at 32768 blocks (constraint C6). Kept here
 * because it is a Minecraft fact, not a Worldloom one.
 */
export const MAX_FILL_BLOCKS = 32_768;
/** Stay under the cap with room to spare. */
export const SAFE_FILL_BLOCKS = 30_000;

/** Chunk coordinates covering a block region, for `forceload` (constraint C5). */
export function chunkRange(
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
): { readonly x0: number; readonly z0: number; readonly x1: number; readonly z1: number } {
  return {
    x0: Math.floor(minX / 16),
    z0: Math.floor(minZ / 16),
    x1: Math.floor(maxX / 16),
    z1: Math.floor(maxZ / 16),
  };
}

/**
 * Parse the block count out of a `fill` response.
 *
 * Bukkit console output capture is not guaranteed by the bridge (`run_command`
 * documents that output "may be empty"), so a null here is normal and the caller
 * falls back to sampling verification rather than trusting a number.
 */
export function parseFilledCount(output: string): number | null {
  const match = /(\d+)\s+block/i.exec(output);
  if (match?.[1] === undefined) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}
