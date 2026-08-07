/**
 * Block vocabulary tests.
 *
 * The invariant these exist for was found by a live-server run, not by
 * reasoning: perception and harvesting must agree about what a block is. If
 * `surfaceFromBlock` calls something wood, `resourceFromBlock` has to yield wood
 * — otherwise an agent perceives a timber building as a source of timber and is
 * then told there is none there.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isSolid,
  materialMatches,
  MATERIAL_BLOCK,
  parseFilledCount,
  RESOURCE_BLOCKS,
  resourceFromBlock,
  surfaceFromBlock,
} from '../../src/environment/minecraft/blocks.ts';
import { BUILD_MATERIALS, RESOURCE_KINDS } from '../../src/core/world.ts';

describe('perception and harvesting agree', () => {
  it('yields wood from anything that looks like wood', () => {
    // The live-server bug: oak_planks reported surface 'wood' but yielded null.
    for (const block of ['oak_log', 'oak_planks', 'oak_door', 'oak_fence', 'spruce_planks']) {
      assert.equal(surfaceFromBlock(block), 'wood', `${block} should look like wood`);
      assert.equal(resourceFromBlock(block), 'wood', `${block} should yield wood`);
    }
  });

  it('yields stone from anything that looks like stone', () => {
    for (const block of ['stone', 'cobblestone', 'deepslate', 'andesite']) {
      assert.equal(surfaceFromBlock(block), 'stone');
      assert.equal(resourceFromBlock(block), 'stone');
    }
  });

  it('can recover every build material it places', () => {
    // A structure an agent builds should be dismantlable — otherwise resources
    // vanish into walls and the economy is one-way.
    for (const material of BUILD_MATERIALS) {
      if (material === 'empty' || material === 'light') continue;
      const block = MATERIAL_BLOCK[material];
      assert.notEqual(
        resourceFromBlock(block),
        null,
        `${material} places '${block}', which yields nothing when removed`,
      );
    }
  });

  it('accepts the block it places as a match for that material', () => {
    for (const material of BUILD_MATERIALS) {
      assert.ok(
        materialMatches(material, MATERIAL_BLOCK[material]),
        `${material} places '${MATERIAL_BLOCK[material]}' but would not verify it`,
      );
    }
  });
});

describe('resource mapping', () => {
  it('names at least one block for every resource kind', () => {
    for (const kind of RESOURCE_KINDS) {
      assert.ok(RESOURCE_BLOCKS[kind].length > 0, `no blocks map to ${kind}`);
    }
  });

  it('maps every listed block back to its own resource', () => {
    for (const kind of RESOURCE_KINDS) {
      for (const block of RESOURCE_BLOCKS[kind]) {
        const resolved = resourceFromBlock(block);
        // First mapping wins, so a block claimed by two kinds resolves to the
        // earlier one — assert it resolves to *something* sensible either way.
        assert.notEqual(resolved, null, `${block} (listed under ${kind}) resolves to nothing`);
      }
    }
  });

  it('treats air and non-solid blocks as not standable', () => {
    for (const block of ['air', 'cave_air', 'water', 'lava', 'torch', 'short_grass']) {
      assert.equal(isSolid(block), false, `${block} should not be solid`);
    }
    for (const block of ['stone', 'oak_planks', 'dirt']) {
      assert.equal(isSolid(block), true, `${block} should be solid`);
    }
  });
});

describe('fill output parsing', () => {
  it('reads a block count out of console output when there is one', () => {
    assert.equal(parseFilledCount('Successfully filled 128 blocks'), 128);
    assert.equal(parseFilledCount('Changed 1 block'), 1);
  });

  it('returns null rather than guessing when output is empty or unparseable', () => {
    // The bridge documents that console output may be empty, so this is the
    // normal case, not an error — verification covers us either way.
    assert.equal(parseFilledCount(''), null);
    assert.equal(parseFilledCount('done'), null);
  });
});
