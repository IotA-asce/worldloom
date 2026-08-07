/**
 * Structure blueprints, in environment-agnostic materials.
 *
 * These are civilization concepts, not Minecraft ones — a blueprint asks for
 * `timber` and `masonry`, and the adapter decides what block that is. Each has a
 * real resource cost derived from its blocks, which is what the ledger charges
 * for (ADR-0004): a shelter is expensive because it is 100-odd blocks, not
 * because a constant says so.
 */

import {
  blueprintCost,
  type Blueprint,
  type BlueprintBlock,
  type BuildMaterial,
  type ResourceBundle,
} from '../core/world.ts';

interface BoxSpec {
  readonly width: number;
  readonly height: number;
  readonly depth: number;
}

/** Floor slab plus hollow walls plus roof, with a doorway punched in one side. */
function hut(size: BoxSpec, wall: BuildMaterial, floor: BuildMaterial, roof: BuildMaterial): BlueprintBlock[] {
  const blocks: BlueprintBlock[] = [];
  const maxX = size.width - 1;
  const maxZ = size.depth - 1;
  const roofY = size.height;

  for (let dx = 0; dx <= maxX; dx++) {
    for (let dz = 0; dz <= maxZ; dz++) {
      blocks.push({ dx, dy: 0, dz, material: floor });
      blocks.push({ dx, dy: roofY, dz, material: roof });
    }
  }

  for (let dy = 1; dy < roofY; dy++) {
    for (let dx = 0; dx <= maxX; dx++) {
      for (let dz = 0; dz <= maxZ; dz++) {
        const onEdge = dx === 0 || dx === maxX || dz === 0 || dz === maxZ;
        // Interior must be empty, or the agent has built itself a solid cube.
        blocks.push({ dx, dy, dz, material: onEdge ? wall : 'empty' });
      }
    }
  }

  // A doorway in the middle of the -z wall, and a light inside so it's usable.
  const doorX = Math.floor(maxX / 2);
  blocks.push({ dx: doorX, dy: 1, dz: 0, material: 'door' });
  blocks.push({ dx: doorX, dy: 2, dz: 0, material: 'empty' });
  blocks.push({ dx: doorX, dy: roofY - 1, dz: Math.floor(maxZ / 2), material: 'light' });

  return blocks;
}

/** Open-topped soil beds, for growing food. */
function farmPlot(size: BoxSpec): BlueprintBlock[] {
  const blocks: BlueprintBlock[] = [];
  for (let dx = 0; dx < size.width; dx++) {
    for (let dz = 0; dz < size.depth; dz++) {
      blocks.push({ dx, dy: 0, dz, material: 'packed_soil' });
      // Clear the air above so crops have room and the plot reads as a farm.
      blocks.push({ dx, dy: 1, dz, material: 'empty' });
    }
  }
  // A low masonry kerb, so it looks deliberate and holds its shape.
  for (let dx = 0; dx < size.width; dx++) {
    blocks.push({ dx, dy: 0, dz: -1, material: 'masonry' });
    blocks.push({ dx, dy: 0, dz: size.depth, material: 'masonry' });
  }
  return blocks;
}

function blueprint(name: string, size: BoxSpec, blocks: BlueprintBlock[]): Blueprint {
  return { name, size, blocks };
}

/** The settlement's first structure: small, cheap, and enough to survive a night. */
export const SMALL_SHELTER: Blueprint = blueprint(
  'small_shelter',
  { width: 5, height: 3, depth: 5 },
  hut({ width: 5, height: 3, depth: 5 }, 'timber', 'masonry', 'timber'),
);

/** Bigger, for the whole group. */
export const COMMUNAL_SHELTER: Blueprint = blueprint(
  'communal_shelter',
  { width: 9, height: 4, depth: 7 },
  hut({ width: 9, height: 4, depth: 7 }, 'timber', 'masonry', 'timber'),
);

/** Where the settlement's shared resources live. */
export const STORAGE: Blueprint = blueprint(
  'storage',
  { width: 5, height: 3, depth: 7 },
  hut({ width: 5, height: 3, depth: 7 }, 'masonry', 'masonry', 'timber'),
);

export const SMALL_FARM: Blueprint = blueprint(
  'small_farm',
  { width: 7, height: 1, depth: 5 },
  farmPlot({ width: 7, height: 1, depth: 5 }),
);

/** A sheltered entrance so a mine is a structure rather than a hole. */
export const MINE_ENTRANCE: Blueprint = blueprint(
  'mine_entrance',
  { width: 3, height: 3, depth: 3 },
  [
    ...hut({ width: 3, height: 3, depth: 3 }, 'timber', 'masonry', 'timber'),
    // Carve a shaft down through the floor.
    { dx: 1, dy: 0, dz: 1, material: 'empty' },
    { dx: 1, dy: -1, dz: 1, material: 'empty' },
    { dx: 1, dy: -2, dz: 1, material: 'empty' },
    { dx: 1, dy: -3, dz: 1, material: 'empty' },
  ],
);

export const BLUEPRINTS: Readonly<Record<string, Blueprint>> = {
  small_shelter: SMALL_SHELTER,
  communal_shelter: COMMUNAL_SHELTER,
  storage: STORAGE,
  small_farm: SMALL_FARM,
  mine_entrance: MINE_ENTRANCE,
};

export function findBlueprint(name: string): Blueprint | null {
  return BLUEPRINTS[name] ?? null;
}

/** What a blueprint costs the ledger. Derived from its blocks, never declared. */
export function costOf(name: string): ResourceBundle {
  const found = findBlueprint(name);
  return found === null ? {} : blueprintCost(found);
}

/** The structure type a blueprint produces, for the settlement record. */
export const STRUCTURE_TYPE: Readonly<Record<string, string>> = {
  small_shelter: 'shelter',
  communal_shelter: 'shelter',
  storage: 'storage',
  small_farm: 'farm',
  mine_entrance: 'mine',
};

export function structureTypeOf(blueprintName: string): string {
  return STRUCTURE_TYPE[blueprintName] ?? blueprintName;
}
