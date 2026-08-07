import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRng } from '../../src/core/rng.ts';

describe('createRng', () => {
  it('is reproducible from a seed', () => {
    const a = createRng(42);
    const b = createRng(42);
    const drawsA = Array.from({ length: 20 }, () => a.next());
    const drawsB = Array.from({ length: 20 }, () => b.next());
    assert.deepEqual(drawsA, drawsB);
  });

  it('produces different sequences for different seeds', () => {
    const a = Array.from({ length: 10 }, createRng(1).next);
    const b = Array.from({ length: 10 }, createRng(2).next);
    assert.notDeepEqual(a, b);
  });

  it('stays within [0, 1)', () => {
    const rng = createRng(7);
    for (let i = 0; i < 1000; i++) {
      const v = rng.next();
      assert.ok(v >= 0 && v < 1, `draw ${v} out of range`);
    }
  });

  it('int is inclusive at both bounds and never escapes them', () => {
    const rng = createRng(3);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const v = rng.int(1, 6);
      assert.ok(Number.isInteger(v));
      assert.ok(v >= 1 && v <= 6, `int ${v} out of range`);
      seen.add(v);
    }
    // A fair d6 over 500 draws should hit every face.
    assert.equal(seen.size, 6);
  });

  it('int handles a single-value range', () => {
    assert.equal(createRng(1).int(5, 5), 5);
  });

  it('int rejects an inverted range', () => {
    assert.throws(() => createRng(1).int(10, 1), /max \(1\) < min \(10\)/);
  });

  it('pick throws on an empty array rather than returning undefined', () => {
    assert.throws(() => createRng(1).pick([]), /empty array/);
  });

  it('shuffle preserves elements and does not mutate the input', () => {
    const input = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8]);
    const shuffled = createRng(9).shuffle(input);
    assert.deepEqual([...shuffled].sort((x, y) => x - y), [...input]);
    assert.deepEqual(input, [1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('shuffle actually reorders', () => {
    const input = Array.from({ length: 30 }, (_, i) => i);
    assert.notDeepEqual(createRng(11).shuffle(input), input);
  });

  it('shuffle handles empty and single-element arrays', () => {
    const rng = createRng(1);
    assert.deepEqual(rng.shuffle([]), []);
    assert.deepEqual(rng.shuffle(['only']), ['only']);
  });

  it('chance is bounded by 0 and 1 probabilities', () => {
    const rng = createRng(5);
    for (let i = 0; i < 50; i++) {
      assert.equal(rng.chance(0), false);
      assert.equal(rng.chance(1), true);
    }
  });

  it('chance approximates its probability', () => {
    const rng = createRng(13);
    let hits = 0;
    const trials = 5000;
    for (let i = 0; i < trials; i++) if (rng.chance(0.3)) hits++;
    const rate = hits / trials;
    assert.ok(Math.abs(rate - 0.3) < 0.03, `rate ${rate} too far from 0.3`);
  });

  it('forks are deterministic per label but independent of each other', () => {
    const parent = createRng(100);
    const scheduler = parent.fork('scheduler');
    const verification = parent.fork('verification');
    assert.notDeepEqual(
      Array.from({ length: 5 }, scheduler.next),
      Array.from({ length: 5 }, verification.next),
    );

    // Same label from an equally-seeded parent reproduces the sequence, so a
    // subsystem's randomness doesn't shift when another one is added.
    const again = createRng(100).fork('scheduler');
    assert.deepEqual(
      Array.from({ length: 5 }, createRng(100).fork('scheduler').next),
      Array.from({ length: 5 }, again.next),
    );
  });

  it('a fork does not advance the parent sequence', () => {
    const a = createRng(77);
    const before = a.next();
    a.fork('anything');
    const plain = createRng(77);
    plain.next();
    assert.equal(a.next(), plain.next());
    assert.equal(before, createRng(77).next());
  });
});
