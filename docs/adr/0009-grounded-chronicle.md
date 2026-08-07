# ADR-0009 — Chronicle is generated only from ledger events

**Status:** accepted · **Date:** 2026-08-07

## Context

Requirement 22 is emphatic: "The chronicle must NEVER invent major events that
did not happen. It is a narrative representation of the event ledger." An LLM
asked to write history will happily embellish, and embellishment here destroys
the artifact's value — the chronicle is the project's most visible output, and
it is worthless if it is fiction.

## Decision

The generator is a **pipeline with a structural guarantee**, not a prompt
instruction:

1. **Select.** Query events for the day whose `importance` clears a threshold, or
   whose type is in the always-notable set (`structure_completed`, `agent_died`,
   `resource_discovered`, `goal_failed`, `settlement_founded`, …).
2. **Render deterministically.** Each event has a template producing a factual
   sentence: `structure_completed` → "Mira completed the storage building at
   (142, 68, -91) on day 4." This produces a correct, if dry, chronicle with
   **no LLM at all** — the `HeuristicProvider` path.
3. **Narrate.** The LLM receives *only* the rendered factual sentences, with
   instructions to combine them into prose. It never sees the raw world, other
   days, or agent memories.
4. **Verify.** Every entity mentioned in the output — agent names, structure
   types, coordinates, day numbers — is checked against the event set it was
   given. A mention with no backing event fails the entry, which is then
   regenerated once and, failing again, falls back to the deterministic
   rendering from step 2.

Each chronicle entry persists the event ids it was built from, so any sentence
is traceable to its evidence.

## Why verification rather than trust

Step 4 is the whole point. Steps 1–3 are a normal summarisation pipeline; a
model given only facts still drifts, inventing a plausible "and they celebrated
by the fire". The verifier is deterministic and cheap, and the fallback means a
drifting model degrades the *prose quality* rather than the *truth* of the
history. This is the difference between "we told it not to lie" and "it cannot".

## Alternatives rejected

- **Prompt the model with the raw event log and trust it** — unverifiable, and
  the failure is invisible until someone checks the ledger.
- **Deterministic templates only** — completely truthful and completely
  lifeless; requirement 22's example output is clearly prose.
- **Let the chronicle read agent memories for colour** — memories include
  beliefs and mistakes; mixing them in would put unfounded claims into the
  historical record. Beliefs belong in biographies later, clearly attributed.

## Consequences

- The chronicle can never mention an event absent from the ledger, satisfying
  requirement 47's final clause structurally.
- Coordinates and names in the narrative are always real.
- The verifier is conservative and will sometimes reject good prose over an
  unrecognised paraphrase. Tuning is a known follow-up; erring toward rejection
  is the right default.
- Future eras, biographies and myths layer on the same select→render→narrate→
  verify shape at coarser granularity.
