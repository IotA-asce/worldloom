import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  describeFailure,
  expect as expectValue,
  fail,
  isFail,
  isOk,
  mapResult,
  ok,
} from '../../src/core/result.ts';

describe('Result', () => {
  it('carries a success value', () => {
    const r = ok(42);
    assert.equal(r.ok, true);
    assert.ok(isOk(r));
    assert.equal(isFail(r), false);
    if (r.ok) assert.equal(r.value, 42);
  });

  it('carries a failure kind and detail', () => {
    const r = fail('PATH_BLOCKED', 'cliff at (10, 64, 20)');
    assert.equal(r.ok, false);
    assert.ok(isFail(r));
    if (!r.ok) {
      assert.equal(r.failure.kind, 'PATH_BLOCKED');
      assert.equal(r.failure.detail, 'cliff at (10, 64, 20)');
    }
  });

  it('omits optional fields rather than setting them undefined', () => {
    // exactOptionalPropertyTypes makes this a type error to construct wrongly;
    // this asserts the runtime shape too, since these objects get serialised
    // into plan-step failure columns and JSON events.
    const r = fail('TIMEOUT', 'move exceeded 15s');
    if (r.ok) return assert.fail('expected failure');
    assert.equal('observed' in r.failure, false);
    assert.equal('retryable' in r.failure, false);
    assert.equal(JSON.stringify(r.failure), '{"kind":"TIMEOUT","detail":"move exceeded 15s"}');
  });

  it('keeps observed detail so the agent can correct its knowledge', () => {
    // The point of `observed`: a failed harvest that found stone teaches the
    // agent the vein is gone (ADR-0008).
    const r = fail('RESOURCE_UNAVAILABLE', 'expected iron', {
      observed: { block: 'stone' },
      retryable: false,
    });
    if (r.ok) return assert.fail('expected failure');
    assert.deepEqual(r.failure.observed, { block: 'stone' });
    assert.equal(r.failure.retryable, false);
  });

  it('preserves a falsy retryable flag', () => {
    const r = fail('VERIFICATION_FAILED', 'block did not change', { retryable: false });
    if (r.ok) return assert.fail('expected failure');
    assert.equal('retryable' in r.failure, true);
    assert.equal(r.failure.retryable, false);
  });

  it('mapResult transforms success and passes failure through untouched', () => {
    assert.deepEqual(mapResult(ok(2), (n) => n * 3), ok(6));

    const failure = fail<number>('INTERNAL', 'boom');
    const mapped = mapResult(failure, (n) => n * 3);
    assert.equal(mapped.ok, false);
    if (!mapped.ok) assert.equal(mapped.failure.detail, 'boom');
  });

  it('mapResult does not invoke its function on failure', () => {
    let called = false;
    mapResult(fail<number>('TIMEOUT', 'x'), (n) => {
      called = true;
      return n;
    });
    assert.equal(called, false);
  });

  it('expect unwraps success', () => {
    assert.equal(expectValue(ok('value'), 'context'), 'value');
  });

  it('expect throws with context and the failure kind', () => {
    assert.throws(
      () => expectValue(fail('REGION_RESERVED', 'held by agent_000002'), 'reserving build site'),
      /reserving build site: \[REGION_RESERVED\] held by agent_000002/,
    );
  });

  it('describeFailure formats for logs and plan-step storage', () => {
    const r = fail('INSUFFICIENT_RESOURCES', 'need 12 more oak_log');
    if (r.ok) return assert.fail('expected failure');
    assert.equal(describeFailure(r.failure), '[INSUFFICIENT_RESOURCES] need 12 more oak_log');
  });
});
