/**
 * Failures in Worldloom are values, not exceptions (ADR-0008).
 *
 * An action that fails carries structured detail the planner can react to —
 * and often carries what was actually observed, so the agent can correct its
 * world knowledge instead of merely retrying.
 */

/** Every way an action can fail. Deliberately closed: adding a kind is a
 *  visible decision, and every kind must be handled by the planner. */
export type FailureKind =
  /** The resource we expected to harvest wasn't there (vein exhausted, tree gone). */
  | 'RESOURCE_UNAVAILABLE'
  /** Terrain between here and the destination is impassable. */
  | 'PATH_BLOCKED'
  /** Another agent holds a reservation on the region we need (ADR-0005). */
  | 'REGION_RESERVED'
  /** The ledger can't cover this build; acquisition must happen first. */
  | 'INSUFFICIENT_RESOURCES'
  /** The world changed under us between planning and acting. */
  | 'TARGET_CHANGED'
  /** We wrote to the world and reading it back disagreed (constraint C5). */
  | 'VERIFICATION_FAILED'
  /** The bridge is unreachable or dropped us (constraint C3). */
  | 'ENVIRONMENT_DISCONNECTED'
  /** A command exceeded its deadline. */
  | 'TIMEOUT'
  /** The model's structured output failed validation past its retries. */
  | 'REASONING_INVALID'
  /** The action isn't supported in the current embodiment mode. */
  | 'UNSUPPORTED'
  /** Anything genuinely unexpected. Should be rare; investigate occurrences. */
  | 'INTERNAL';

export interface ActionFailure {
  readonly kind: FailureKind;
  /** Human-readable, specific enough to debug from a log line alone. */
  readonly detail: string;
  /**
   * What we actually observed, when the failure revealed something about the
   * world. The planner feeds this back into agent knowledge — a failed harvest
   * that found stone where it expected iron should *teach* the agent.
   */
  readonly observed?: unknown;
  /** Whether retrying the identical action could plausibly succeed. */
  readonly retryable?: boolean;
}

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: ActionFailure };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail<T = never>(
  kind: FailureKind,
  detail: string,
  extra: { observed?: unknown; retryable?: boolean } = {},
): Result<T> {
  // Build the object conditionally: exactOptionalPropertyTypes means an
  // explicit `undefined` is not assignable to an optional property.
  const failure: ActionFailure = {
    kind,
    detail,
    ...(extra.observed !== undefined ? { observed: extra.observed } : {}),
    ...(extra.retryable !== undefined ? { retryable: extra.retryable } : {}),
  };
  return { ok: false, failure };
}

/** Narrowing helpers, so call sites read as prose. */
export function isOk<T>(r: Result<T>): r is { ok: true; value: T } {
  return r.ok;
}

export function isFail<T>(r: Result<T>): r is { ok: false; failure: ActionFailure } {
  return !r.ok;
}

/** Unwrap or throw — only for tests and for genuinely unrecoverable startup paths. */
export function expect<T>(r: Result<T>, context: string): T {
  if (r.ok) return r.value;
  throw new Error(`${context}: [${r.failure.kind}] ${r.failure.detail}`);
}

export function mapResult<T, U>(r: Result<T>, f: (value: T) => U): Result<U> {
  return r.ok ? ok(f(r.value)) : r;
}

/** Format a failure for logs and for storage on a plan step. */
export function describeFailure(failure: ActionFailure): string {
  return `[${failure.kind}] ${failure.detail}`;
}
