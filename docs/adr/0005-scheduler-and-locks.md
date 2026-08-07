# ADR-0005 — Interleaved ticks, concurrency cap, region reservations

**Status:** accepted · **Date:** 2026-08-07

## Context

Requirement 30: one slow LLM call must not block the other four agents.
Requirement 44 asks what happens when two agents modify the same location. And
the bridge is a single connection serving everyone.

## Decision

**Scheduler.** A cooperative loop keeps a ready queue of agents. Each due agent's
tick runs as an async task; up to `max_concurrency` (default 3) run at once.
A slow model call parks that agent's task and others proceed. Correctness first:
per-agent ticks never overlap with themselves.

**Bridge serialisation.** The bridge client owns one socket and correlates by
id, so concurrent commands from different agents interleave safely at the
protocol level. A small in-flight cap prevents a burst of surveys from starving
interactive commands.

**Region reservations.** Before any mutation an agent must hold a reservation on
the axis-aligned region it will touch. Reservations are rows with an owner and
an expiry; overlapping requests are refused. A refused reservation is a
first-class planning failure (`REGION_RESERVED`) that the planner handles by
waiting, choosing another site, or asking the holder — which is exactly the
friction that produces coordination rather than eliminating it.

Reservations expire so a crashed or dead agent cannot deadlock a site forever.

**Ordering.** Agents tick in a rotation shuffled from a seeded RNG each round,
so no agent permanently gets first pick of contested work.

## Alternatives rejected

- **Strict sequential ticks** — simplest, but five agents × one 4 s model call
  means a 20 s wall clock per round, and it hides all concurrency bugs until
  they surface later at higher cost.
- **Unbounded concurrency** — bursts of API calls, rate-limit failures, and
  chunked `fill` operations racing each other in the same volume.
- **Global world mutex** — correct and trivially safe, but it serialises all
  building, which removes the possibility of agents working in parallel at all.
- **Optimistic concurrency (build, detect conflict, repair)** — attractive, but
  C5 (silent `fill` failure on unloaded chunks) makes reliable conflict
  detection hard. Pessimistic reservations are the safer V0 choice.

## Consequences

- Two agents genuinely cannot corrupt each other's build. The failure they get
  instead is legible and drives negotiation.
- `forceload` bracketing pairs naturally with reservation lifetime.
- Reservation granularity is a tuning knob: too coarse and agents block each
  other needlessly, too fine and the table churns. Start with per-project
  bounding boxes.
- Wall-clock determinism is lost with concurrency. Accepted — the seeded
  rotation plus the `Decision` audit trail preserves *explainability*, which is
  what requirement 31 actually asks for.
