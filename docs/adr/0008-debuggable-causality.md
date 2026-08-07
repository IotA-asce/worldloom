# ADR-0008 — Persist observations, memories, prompts and outcomes per decision

**Status:** accepted · **Date:** 2026-08-07

## Context

Requirement 31 sets the bar precisely: full deterministic replay of LLM
reasoning is not required, but a developer must be able to ask "why did Mira
abandon the farm project?" and trace the answer. Requirement 28 requires action
failures to reach the planner rather than being swallowed by retries.

## Decision

**Every reasoning-influenced decision writes a `decisions` row** capturing the
inputs and the output: the normalised observation, the ids of retrieved
memories, the rendered prompt, the raw response, the model, token counts, and
the action chosen. The row links to the event the decision produced, so the
ledger and the reasoning behind it are joinable.

**Failures are typed values, not exceptions.** Every `Environment` method
returns a result carrying either success or:

```ts
type ActionFailure = {
  kind: 'RESOURCE_UNAVAILABLE' | 'PATH_BLOCKED' | 'REGION_RESERVED'
      | 'INSUFFICIENT_RESOURCES' | 'TARGET_CHANGED' | 'VERIFICATION_FAILED'
      | 'ENVIRONMENT_DISCONNECTED' | 'TIMEOUT' | 'REASONING_INVALID'
  detail: string
  observed?: unknown      // what we actually saw, for knowledge correction
}
```

A failure does three things: it becomes an `action_failed` event, it updates the
agent's knowledge when it revealed something (an exhausted deposit lowers that
`known_resource`'s confidence to zero — the agent *learns* the vein is gone),
and it advances the plan step's `attempts` and `failure` fields.

**Retries are bounded and only where semantically safe.** Transient transport
errors retry idempotent commands (C3). Everything else surfaces after at most
`max_attempts` (default 2) to the planner, which replans. No infinite retry
loops, per requirement 28.

## Alternatives rejected

- **Log lines only** — greppable text can't answer "which memories did she
  retrieve", and correlating five interleaved agents across a log is exactly the
  "console spam" requirement 23 rejects.
- **Full deterministic replay (seed + cached completions)** — genuinely useful,
  and a large amount of machinery for V0. The `decisions` table already answers
  the questions we need; replay can be built on top of it later since the
  prompts and responses are already stored.
- **Exceptions for failures** — a thrown error loses the structured detail the
  planner needs to react, and encourages catch-and-retry at the wrong layer.

## Consequences

- `worldloom inspect decision <id>` and `worldloom why <agent>` can be thin
  queries over stored rows.
- Prompt and response storage grows fast. Mitigated by storing prompts once with
  a hash and referencing them, plus a retention setting for response bodies.
- Prompts may contain nothing secret by construction (no API keys in prompts),
  but the database is local-only and gitignored regardless.
