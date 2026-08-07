import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { asId, idPrefix, isId, randomIdFactory, sequentialIdFactory } from '../../src/core/ids.ts';

describe('id factories', () => {
  it('sequential ids are stable, ordered and padded', () => {
    const ids = sequentialIdFactory();
    assert.equal(ids.next('agent'), 'agent_000001');
    assert.equal(ids.next('agent'), 'agent_000002');
    // Counters are per-prefix, so adding a memory doesn't shift agent numbering.
    assert.equal(ids.next('mem'), 'mem_000001');
    assert.equal(ids.next('agent'), 'agent_000003');
  });

  it('two sequential factories produce identical sequences', () => {
    const a = sequentialIdFactory();
    const b = sequentialIdFactory();
    assert.equal(a.next('evt'), b.next('evt'));
  });

  it('random ids are prefixed and unique', () => {
    const ids = randomIdFactory();
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const id = ids.next('mem');
      assert.match(id, /^mem_[0-9a-f]{12}$/);
      assert.ok(!seen.has(id), `duplicate id ${id}`);
      seen.add(id);
    }
  });

  it('idPrefix recovers a known prefix and rejects unknown ones', () => {
    assert.equal(idPrefix('agent_000001'), 'agent');
    assert.equal(idPrefix('struct_abc'), 'struct');
    assert.equal(idPrefix('nonsense_1'), null);
    assert.equal(idPrefix('noseparator'), null);
  });

  it('isId discriminates between prefixes that share a stem', () => {
    // 'stmt' (settlement) and 'struct' both start with 'st'.
    assert.ok(isId('stmt_1', 'stmt'));
    assert.ok(!isId('stmt_1', 'struct'));
    assert.ok(!isId('struct_1', 'stmt'));
  });

  it('asId passes valid ids through and rejects mismatches', () => {
    assert.equal(asId('goal_000007', 'goal'), 'goal_000007');
    assert.throws(() => asId('agent_000001', 'goal'), /expected a goal id, got 'agent_000001'/);
    assert.throws(() => asId('', 'agent'), /expected a agent id/);
  });
});
