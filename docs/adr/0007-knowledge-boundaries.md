# ADR-0007 — Per-agent knowledge, enforced by repository shape

**Status:** accepted · **Date:** 2026-08-07

## Context

Requirement 9: agents must not be omniscient. Requirement 44 asks how we prevent
accidental omniscience. This is easy to state and easy to violate — one
convenience query joining across agents, or one prompt built from a global world
model, and the whole social dynamic of knowledge transfer becomes theatre.

## Decision

Knowledge is **owned by an agent, not by the world**. `known_locations`,
`known_resources`, `memories` and `relationships` are all keyed by `agent_id`,
and each row carries a `source`:

```
source = observed            | told_by:<agent_id>
       | inferred            | settlement_record
```

Three enforcement mechanisms, in increasing strength:

1. **Repository API shape.** `KnowledgeRepository` methods all take an
   `agentId` as their first argument. There is no `findAllKnownResources()`. To
   read another agent's knowledge you would have to add a method that doesn't
   exist, which is a visible act in review rather than an easy mistake.

2. **Observation scoping.** The `Environment` port's `observe(agent, radius)`
   takes the agent and returns only what is sensible from its position. The
   adapter cannot return the whole world because the port has no shape for it.

3. **A test that greps.** `tests/knowledge-boundaries.test.ts` asserts that no
   prompt-building code path reads a knowledge row whose `agent_id` differs from
   the agent being prompted, and that every `known_*` insert supplies a source.

Settlement state is the one deliberate exception, and it is narrow: `Settlement`
holds *observable public facts* — that a structure exists at a location, that a
project is claimed. An agent learns these by being present or by being told;
`settlement_record` marks knowledge acquired from shared institutional record
rather than magic. Private beliefs never live there.

## Alternatives rejected

- **One shared world model with per-agent visibility filters** — much simpler,
  and it makes omniscience the default with a filter as the only guard. One
  forgotten filter silently ends the simulation's honesty, and the bug is nearly
  invisible in output.
- **Trust prompt authors** — prompts are the exact place leaks happen.

## Consequences

- Knowledge duplication across agents is expected, and divergence is a feature:
  Arun's iron deposit at 60 % confidence and Mira's at 90 % after seeing it
  herself is correct behaviour.
- Knowledge transfer must be modelled explicitly, which is what makes
  requirement 35's "knowledge transfer" criterion a real demonstration.
- Cost: more rows and more writes than a shared model. Irrelevant at V0 scale.
