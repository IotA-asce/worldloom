import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  blueprintCost,
  blueprintRegion,
  bundleAdd,
  bundleIsEmpty,
  bundleScale,
  bundleShortfall,
  distance,
  expandRegion,
  formatBundle,
  formatPosition,
  horizontalDistance,
  position,
  positionKey,
  region,
  regionCenter,
  regionContains,
  regionPositions,
  regionVolume,
  regionsOverlap,
  samePosition,
  type Blueprint,
} from '../../src/core/world.ts';

describe('positions', () => {
  it('measures straight-line distance', () => {
    assert.equal(distance(position(0, 0, 0), position(3, 4, 0)), 5);
    assert.equal(distance(position(0, 0, 0), position(0, 0, 0)), 0);
  });

  it('measures horizontal distance ignoring elevation', () => {
    // A block 10 above is not a 10-block walk — this is why travel uses it.
    assert.equal(horizontalDistance(position(0, 0, 0), position(0, 10, 0)), 0);
    assert.equal(horizontalDistance(position(0, 99, 0), position(3, 0, 4)), 5);
  });

  it('compares by value', () => {
    assert.ok(samePosition(position(1, 2, 3), position(1, 2, 3)));
    assert.ok(!samePosition(position(1, 2, 3), position(1, 2, 4)));
  });

  it('keys uniquely per block', () => {
    assert.equal(positionKey(position(1, -2, 3)), '1,-2,3');
    assert.notEqual(positionKey(position(1, 2, 3)), positionKey(position(3, 2, 1)));
  });

  it('formats compactly, rounding fractional coordinates', () => {
    assert.equal(formatPosition(position(142, 68, -91)), '(142, 68, -91)');
    assert.equal(formatPosition(position(1.4, 2.6, 3.5)), '(1, 3, 4)');
  });
});

describe('regions', () => {
  it('normalises corners given in any order', () => {
    const r = region(position(10, 70, 10), position(0, 60, 5));
    assert.deepEqual(r.min, position(0, 60, 5));
    assert.deepEqual(r.max, position(10, 70, 10));
  });

  it('contains its own corners (bounds are inclusive)', () => {
    const r = region(position(0, 0, 0), position(2, 2, 2));
    assert.ok(regionContains(r, position(0, 0, 0)));
    assert.ok(regionContains(r, position(2, 2, 2)));
    assert.ok(regionContains(r, position(1, 1, 1)));
    assert.ok(!regionContains(r, position(3, 1, 1)));
    assert.ok(!regionContains(r, position(-1, 1, 1)));
  });

  it('detects overlap, including touching faces', () => {
    const a = region(position(0, 0, 0), position(5, 5, 5));
    // Sharing the x=5 plane is a real conflict: both would write that block.
    assert.ok(regionsOverlap(a, region(position(5, 0, 0), position(9, 5, 5))));
    assert.ok(regionsOverlap(a, region(position(2, 2, 2), position(3, 3, 3))));
    assert.ok(!regionsOverlap(a, region(position(6, 0, 0), position(9, 5, 5))));
    // Separated on one axis only is still no overlap.
    assert.ok(!regionsOverlap(a, region(position(0, 6, 0), position(5, 9, 5))));
  });

  it('overlap is symmetric', () => {
    const a = region(position(0, 0, 0), position(5, 5, 5));
    const b = region(position(3, 3, 3), position(8, 8, 8));
    assert.equal(regionsOverlap(a, b), regionsOverlap(b, a));
  });

  it('counts volume inclusively', () => {
    assert.equal(regionVolume(region(position(0, 0, 0), position(0, 0, 0))), 1);
    assert.equal(regionVolume(region(position(0, 0, 0), position(1, 1, 1))), 8);
    assert.equal(regionVolume(region(position(0, 0, 0), position(9, 4, 9))), 500);
  });

  it('finds the centre', () => {
    assert.deepEqual(regionCenter(region(position(0, 0, 0), position(2, 4, 6))), position(1, 2, 3));
  });

  it('expands on every axis', () => {
    const r = expandRegion(region(position(0, 0, 0), position(1, 1, 1)), 2);
    assert.deepEqual(r.min, position(-2, -2, -2));
    assert.deepEqual(r.max, position(3, 3, 3));
  });

  it('enumerates every block exactly once', () => {
    const r = region(position(0, 0, 0), position(1, 1, 1));
    const seen = [...regionPositions(r)].map(positionKey);
    assert.equal(seen.length, 8);
    assert.equal(new Set(seen).size, 8);
  });
});

describe('resource bundles', () => {
  it('treats absent keys as zero', () => {
    assert.ok(bundleIsEmpty({}));
    assert.ok(bundleIsEmpty({ wood: 0 }));
    assert.ok(!bundleIsEmpty({ wood: 1 }));
  });

  it('adds', () => {
    assert.deepEqual(bundleAdd({ wood: 2 }, { wood: 3, stone: 1 }), { wood: 5, stone: 1 });
  });

  it('scales', () => {
    assert.deepEqual(bundleScale({ wood: 2, stone: 3 }, 4), { wood: 8, stone: 12 });
    assert.deepEqual(bundleScale({ wood: 2 }, 0), {});
  });

  it('reports only genuine shortfalls', () => {
    assert.deepEqual(bundleShortfall({ wood: 10, stone: 5 }, { wood: 4 }), { wood: 6, stone: 5 });
    // A surplus is not a negative shortfall.
    assert.deepEqual(bundleShortfall({ wood: 2 }, { wood: 10 }), {});
    assert.ok(bundleIsEmpty(bundleShortfall({ wood: 2 }, { wood: 2 })));
  });

  it('formats for humans', () => {
    assert.equal(formatBundle({ wood: 12, stone: 3 }), '12 wood, 3 stone');
    assert.equal(formatBundle({}), 'nothing');
  });
});

describe('blueprints', () => {
  const hut: Blueprint = {
    name: 'test_hut',
    size: { width: 2, height: 2, depth: 1 },
    blocks: [
      { dx: 0, dy: 0, dz: 0, material: 'timber' },
      { dx: 1, dy: 0, dz: 0, material: 'timber' },
      { dx: 0, dy: 1, dz: 0, material: 'masonry' },
      { dx: 1, dy: 1, dz: 0, material: 'empty' },
    ],
  };

  it('prices a blueprint from its materials', () => {
    // Two timber (1 wood each), one masonry (1 stone), one empty (free).
    assert.deepEqual(blueprintCost(hut), { wood: 2, stone: 1 });
  });

  it('prices an empty blueprint as free', () => {
    assert.deepEqual(blueprintCost({ name: 'nothing', size: { width: 0, height: 0, depth: 0 }, blocks: [] }), {});
  });

  it('computes the region a blueprint occupies once anchored', () => {
    const r = blueprintRegion(hut, position(100, 64, -50));
    assert.deepEqual(r.min, position(100, 64, -50));
    assert.deepEqual(r.max, position(101, 65, -50));
  });

  it('handles blueprints with negative offsets', () => {
    const centred: Blueprint = {
      name: 'centred',
      size: { width: 3, height: 1, depth: 3 },
      blocks: [
        { dx: -1, dy: 0, dz: -1, material: 'masonry' },
        { dx: 1, dy: 0, dz: 1, material: 'masonry' },
      ],
    };
    const r = blueprintRegion(centred, position(0, 64, 0));
    assert.deepEqual(r.min, position(-1, 64, -1));
    assert.deepEqual(r.max, position(1, 64, 1));
  });

  it('degenerates to a single block for an empty blueprint', () => {
    const origin = position(5, 5, 5);
    const r = blueprintRegion({ name: 'e', size: { width: 0, height: 0, depth: 0 }, blocks: [] }, origin);
    assert.deepEqual(r.min, origin);
    assert.deepEqual(r.max, origin);
  });
});
