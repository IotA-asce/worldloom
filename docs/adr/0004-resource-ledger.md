# ADR-0004 — Worldloom owns inventory; gathering is real block removal

**Status:** accepted · **Date:** 2026-08-07

## Context

Logical agents ([ADR-0003](0003-agent-embodiment.md)) have no Minecraft
inventory to read. But requirement 47 forbids the fake-demo failure mode where a
model says "I will build a house" and the program simply builds one. Resources
must be genuinely scarce and genuinely acquired.

## Decision

Worldloom keeps a **resource ledger** — per-agent and per-settlement counts of
`ResourceKind` — and enforces conservation against the real world:

**Credit only against verified removal.** To gather 48 oak logs, the adapter
locates real log blocks (survey → candidate positions), removes them
(`fill`/`break_block`), then re-reads those positions with `get_block_at`. The
ledger is credited with the number of blocks **confirmed to have changed from
log to air**, not the number requested. If the trees weren't there, the agent
gets nothing and the step fails with `RESOURCE_UNAVAILABLE`.

**Debit before placement.** A blueprint is priced in resources. If the ledger
can't cover it, the build step fails with `INSUFFICIENT_RESOURCES` and the
planner inserts an acquisition sub-goal. Blocks are debited as they are
verified placed; a partial build debits only what actually landed.

Transfers between agents are explicit ledger moves emitting
`resource_transferred`, which is what makes "Nadia shared food with Elias"
a real event with a real cost to Nadia.

## Why this is stronger than reading Minecraft's inventory

It is not a workaround; in this design it's a better fit. Survival inventory
would give us 36 slots, stack limits, and tool durability — genuine simulation
noise — while `break_block`'s fixed 1 s delay (C8) makes real harvesting
absurdly slow, and creative mode would make resources free and destroy scarcity
altogether. The ledger keeps scarcity, keeps verification against the real
world, and stays environment-agnostic — a Godot adapter will have its own
notion of "removed a resource from the world" and the same ledger applies.

## Alternatives rejected

- **Trust the model's claims** — the exact failure mode requirement 47 names.
- **Creative-mode building with no accounting** — resources become free;
  gathering, division of labour and scarcity-driven coordination all collapse.
- **Survival inventory via a piloted player** — only works for one agent, and
  C8 makes bulk gathering take minutes of wall clock per stack.

## Consequences

- Every ledger mutation carries the event id that justified it, so the whole
  economy is auditable: `SELECT` the events and the balance reconstructs.
- Verification cost is real — post-harvest sampling costs round trips. Mitigated
  by sampling a bounded subset for large volumes and recording the sample rate
  on the event, so the confidence is explicit rather than assumed.
- Conservation is only enforced within Worldloom. A human player can mine the
  settlement's walls and the ledger won't know. Acceptable for V0; a
  block-change event upstream would close it.
