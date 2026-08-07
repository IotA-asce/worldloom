# ADR-0010 — SQLite via `node:sqlite`, behind a thin port

**Status:** accepted · **Date:** 2026-08-07

## Context

Requirement 25: agents, memories, relationships, goals, plans, knowledge,
settlement state, and the full event history must survive process restarts, and
a restart must resume the civilization rather than reset it. Requirement 44 asks
for the simplest persistence layer that works, and requirement 39 warns against
unnecessary dependencies.

Scale is small: 5 agents, thousands of events, tens of thousands of memories.
But memory retrieval wants scoring and filtering, and the event ledger wants
ordered append plus range queries — both of which are SQL's home ground.

## Decision

**One SQLite database file** (default `./worldloom.db`, gitignored) accessed via
Node's built-in **`node:sqlite`**. No external dependency, no native build step,
no ORM. Schema in `src/persistence/schema.sql` with numbered migrations.

`node:sqlite` is accessed through a ~40-line `Database` port exposing only
`exec`, `prepare`, `transaction`. Its API deliberately mirrors
`better-sqlite3`'s, so if the experimental API shifts or we need a stable
guarantee, swapping the implementation is a one-file change with no callers
touched.

WAL mode, foreign keys on. The `events` table is append-only — no update or
delete path exists in its repository.

## Alternatives rejected

- **JSON files per agent** — no dependency at all, but memory retrieval becomes
  a full in-memory scan and sort, concurrent writes risk partial files, and
  there is no transaction across an event write plus a ledger debit. Those two
  must be atomic or the economy can drift.
- **`better-sqlite3`** — mature and stable, at the cost of a native module and
  a compile step on install, which is real friction for an OSS project's first
  `npm install`. Held as the fallback, made cheap by the port.
- **Postgres** — operationally absurd for a single-process local simulation.
- **A vector database for memory retrieval** — the interesting option. V0
  retrieval is importance × recency × keyword/tag overlap, which SQL does well
  at these volumes. Embeddings would add a service, a dependency, and a
  per-memory API cost against requirement 29. The retrieval interface is
  designed so a semantic scorer can be added as another term later.

## Consequences

- `npm install` pulls almost nothing; contributors are running in seconds.
- Atomic multi-table writes (event + ledger + memory in one transaction) come
  free, which is what keeps the causal chain consistent under failure.
- `node:sqlite` currently emits an experimental warning; the CLI suppresses just
  that warning and the README states the version requirement (Node ≥ 22.5,
  developed on 24).
- Restart correctness is testable directly: run N ticks, close, reopen, assert
  the agent resumes the same plan step. That test is a V0 success criterion.
