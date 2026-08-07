# V0 Plan — The First Settlement

V0 goal: five persistent autonomous agents establish a settlement in a live
Minecraft world, and the run produces an event ledger and a truthful chronicle.

Sequencing principle: **an end-to-end vertical slice before any breadth.** M1
touches every layer with one agent and one goal. Everything after widens a
working system rather than assembling parts that have never run together.

## Milestones

Each milestone ends with a demonstrable behaviour and passing tests, and lands
as its own merge to `main`.

### M0 — Architecture *(done)*

Architecture, Minecraft integration findings, ADRs for all eleven decisions,
repository scaffold, test harness, CI.

**Done when:** `npm run typecheck && npm test` pass on a clean clone.

### M1 — One persistent agent *(done)*

The vertical slice: domain model, SQLite repositories, `Environment` port with
both `FakeEnvironment` and `MinecraftEnvironment`, bridge client, reasoning
provider abstraction with the heuristic implementation, needs, goals, plans,
deterministic executors, event ledger, tick state machine, CLI.

**Done when:** one agent observes a world, forms a goal, builds a structured
plan, performs a real verified world mutation, stores the experience as memory,
and — after the process is thrown away — resumes the same plan at the same step.

All of that passes, plus more than the milestone asked for: agents gather
verified resources, choose sites, and build and verify structures. Bugs the
milestone flushed out and their fixes are worth recording, because several were
the kind that make a simulation look like it works when it doesn't:

- Agents forgot their goal every tick (the post-action write rebuilt the agent
  from a pre-action snapshot), so they re-decided constantly instead of pursuing
  anything.
- Replanning regenerated an identical plan, so a failing goal looped forever.
  Plans now differ by attempt, and goals are abandoned after a bounded number.
- A failed harvest corrected the wrong coordinates, so agents never learned a
  deposit was empty and walked back to it repeatedly.
- Forests advertised only leaves and open ground only grass, so timber and stone
  were invisible and nothing could ever be built.
- The first shelter required coal for a torch — reachable only by deep mining —
  making a first-night shelter impossible.
- Bounding an observation by total quantity let abundant soil crowd out scarce
  food, so agents starved beside berry bushes.

**Known gaps at the end of M1**, deliberately left for their own milestones:
five agents each build their own shelter rather than one together (M4's
coordination), and food supply is tight enough that agents spend a lot of the
day foraging (M5's economy tuning).

### M2 — Memory

Episodic and semantic memory, selective retrieval scoring, consolidation into
higher-level beliefs, importance decay.

**Done when:** an agent that failed at a location earlier avoids or adapts to it
later, and the `decisions` row proves the memory was retrieved and used.

### M3 — Five agents

Scheduler with interleaved ticks and concurrency cap, region reservations,
per-agent knowledge isolation, messaging as events, relationships.

**Done when:** five agents run concurrently; one discovers a resource, tells
another, and the recipient's `known_resources` gains a row sourced
`told_by:<id>`; a helpful act moves a relationship value and the event explains
why.

### M4 — Goals, projects, division of labor

Settlement state, structures, projects with requirements and claims,
coordination so agents pick different work, failure-driven replanning.

**Done when:** five agents hold five meaningfully different active goals chosen
without a central scheduler assigning them, and a blocked plan recovers
unattended.

### M5 — Settlement

Blueprints and the builder (ported chunked-fill/verify logic), resource
acquisition, food, shelter, storage.

**Done when:** a shelter and a storage structure exist in the world, are
recorded as `Structure` rows, and were paid for from the resource ledger.

### M6 — Chronicle

Importance classification, the select→render→narrate→verify pipeline.

**Done when:** a multi-day chronicle reads well and every entity in it resolves
to a real event; the verifier is proven by a test that feeds it a fabricated
sentence and sees it rejected.

### M7 — Observability

`worldloom inspect`, `events`, `why`, `costs`; structured logging; live status.

**Done when:** a developer can answer "what is each agent doing and why" and
"what did this run cost" from the CLI alone.

### M8 — First Settlement demo

Full scenario against a live server; collect ledger, chronicle, metrics,
screenshots, and an honest list of known failures.

**Done when:** every criterion in §35 of the requirements is demonstrated, with
the artifact to prove each one.

## Issue-sized tasks

Independently reviewable units, sized at roughly one focused sitting each.

**M1 — vertical slice**
1. `core/`: ids, `Result`/`ActionFailure` types, config loader (YAML + env), seeded RNG
2. `persistence/`: `Database` port over `node:sqlite`, schema v1, migration runner
3. `persistence/repositories/`: agents, events, memories, knowledge, goals, plans, ledger
4. `events/`: event types, append-only store, importance defaults
5. `environment/port.ts`: `Environment` interface, `Observation`, `Blueprint`, `Region`
6. `environment/fake/`: in-memory voxel world with terrain generation for tests
7. `environment/minecraft/bridge-client.ts`: framing, correlation, deadlines, reconnect, idempotent retry
8. `environment/minecraft/adapter.ts`: observe/survey/inspect/move/harvest/build/time
9. `environment/minecraft/blueprints.ts`: chunked fill, dedupe, carve ordering, verification sampling
10. `reasoning/`: provider interface, structured-output validation, `HeuristicProvider`
11. `reasoning/anthropic.ts`: Anthropic provider with per-category routing and token metering
12. `agents/needs.ts`: need model, world-time decay, prioritisation
13. `goals/`: goal state machine, plan representation, deterministic step executors
14. `agents/runtime.ts`: the tick state machine
15. `cli/`: `worldloom run`, `worldloom inspect`
16. Restart-persistence test: tick, kill, reopen, resume

**M2 — memory**
17. Memory store with typed entries and importance
18. Retrieval scoring (recency × importance × relevance) with a retrieval limit
19. Reflection: episodic runs → semantic beliefs
20. Consolidation and decay; `consolidated_into` chains
21. Test: a past failure changes a later decision

**M3 — five agents**
22. Scheduler: ready queue, concurrency cap, seeded rotation
23. Region reservations with expiry; `REGION_RESERVED` handling
24. Messaging: send, deliver at `INTEGRATE`, interpret, update knowledge
25. Relationships: trust/affinity/familiarity driven by event types
26. Knowledge-boundary enforcement test

**M4 — goals and coordination**
27. Settlement and structure records
28. Projects with resource requirements and agent claims
29. Coordination: announce intent, consider existing claims, request help
30. Replanning on failure; goal abandonment

**M5 — settlement**
31. Resource acquisition plans (locate → reserve → harvest → verify → credit)
32. Shelter, storage, farm blueprints
33. Site selection from real terrain surveys
34. Food and safety need satisfaction

**M6 — chronicle**
35. Importance classification
36. Deterministic event renderers
37. Narration + the grounding verifier
38. `worldloom chronicle`

**M7 — observability**
39. Structured logger with agent/event correlation
40. Cost and token metrics by category and agent
41. `worldloom why <agent>` over the `decisions` table
42. Live status output during a run

**M8 — demo**
43. `scenarios/first-settlement`
44. Long-run soak; fix what breaks
45. Capture artifacts; write an honest `docs/results.md`

## Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | Logical embodiment feels like agents aren't "really" in Minecraft | high (credibility) | Terrain-validated movement, verified mutations, visible markers; state it plainly in the README rather than overclaiming |
| R2 | Silent `fill` failures on unloaded chunks corrupt the ledger (C5) | high | `forceload` bracketing plus mandatory post-build verification; credit only what's confirmed |
| R3 | Bridge single-client kicks (C3) destabilise long runs | medium | Reconnect with backoff; idempotent-only retry; documented operational rule |
| R4 | Token cost balloons over a long run | medium | Strict LLM gating, per-category budget caps, metrics from day one, heuristic fallback |
| R5 | Agents converge on identical behaviour, defeating division of labour | medium | Personality-weighted goal scoring, claim awareness, seeded rotation so no agent always picks first |
| R6 | Emergent coordination fails and needs a central scheduler | medium | Claims + messaging first; if it fails, add an explicit settlement work-board — record it as an ADR rather than smuggling it in |
| R7 | Structured output invalid too often to make progress | medium | Bounded retries with validation feedback, heuristic fallback per category, fixtures in CI |
| R8 | `node:sqlite` experimental API changes | low | `Database` port makes `better-sqlite3` a one-file swap |
| R9 | Resource-finding is expensive without a bulk block query | medium | Prefer `get_heightmap`; bounded probe volumes; consider upstreaming `get_blocks` |
| R10 | Long-run memory growth degrades retrieval | low for V0 | Consolidation and decay from M2; retrieval limits |

## Open questions

- **Does emergent coordination actually work at five agents?** R6's real
  answer. Decided by M4 evidence, not in advance.
- **Is heuristic-only play interesting enough to be the default demo?** If so
  it becomes the zero-cost onboarding path; if not, it stays a test fixture.
- **Should we upstream a bulk block query and a block-change event to
  `minecraft-mcp`?** Both would materially help. Deferred until V0 proves the
  need with measurements.
- **How much terrain understanding belongs in the adapter vs. the core?** Site
  suitability is arguably domain logic, but every useful signal is
  Minecraft-shaped. Current line: the adapter returns a normalised
  `TerrainSurvey` (flatness, water proximity, elevation) and the core scores it.
