# ADR-0001 — Agents are async state machines, not actors

**Status:** accepted · **Date:** 2026-08-07

## Context

Five agents must run concurrently. Each tick mixes fast deterministic work
(need decay, plan advancement) with slow I/O (bridge round trips, LLM calls).
Candidate models: an actor system with mailboxes, OS threads/workers,
generators/coroutines, or plain async functions over an explicit state machine.

## Decision

Each agent is an **explicit state machine** whose tick is a plain `async`
function, driven by a central scheduler. Phases are
`OBSERVE → INTEGRATE → ASSESS → PLAN → ACT → RECORD`. The agent's phase and
all its data live in SQLite, not on a call stack.

Messages between agents are rows in a `messages` table drained at `INTEGRATE`,
which gives us actor-style decoupling without an actor runtime.

## Alternatives rejected

- **Actor framework** — buys supervision and mailboxes we'd barely use, and
  makes state live in objects rather than the database, which fights
  requirement 25 (restart mid-plan).
- **Worker threads** — agents are I/O-bound, not CPU-bound. Nothing to gain,
  and SQLite writes would need marshalling.
- **Coroutines holding a stack across awaits** — the elegant version of the tick
  loop, but a suspended generator cannot be serialised. A process restart would
  lose the agent's position in its own lifecycle, exactly what V0 must survive.

## Consequences

- Restart is trivial: an agent resumes because its phase and plan step are
  columns, not stack frames.
- The tick loop is directly testable — call `tick(agent)` and assert on state.
- Phase transitions are observable, so "what is Mira doing and why" reads
  straight out of the database.
- Cost: the state machine must be written explicitly rather than falling out of
  control flow. Accepted; it is the thing that makes persistence and
  observability cheap.
