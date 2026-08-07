# Worldloom Architecture

Worldloom simulates persistent autonomous agents inhabiting a shared world. It
observes, remembers, plans, acts, and records history. Minecraft is the first
environment it plugs into — not what it is about.

This document describes the V0 architecture. Decisions with real alternatives
are recorded as [ADRs](adr/).

## 1. Layers

```
┌─────────────────────────────────────────────────────────┐
│  scenarios/           declarative world + agent setup   │
├─────────────────────────────────────────────────────────┤
│  scheduler/           who ticks, when, how concurrently  │
├─────────────────────────────────────────────────────────┤
│  agents/    goals/    memory/    civilization/          │
│  needs      planner   retrieval  settlement             │
│  skills     plans     consolid.  projects/coordination  │
├──────────────┬──────────────────────┬───────────────────┤
│  reasoning/  │  events/             │  chronicle/       │
│  provider    │  append-only ledger  │  generator        │
├──────────────┴──────────────────────┴───────────────────┤
│  environment/  Environment port (Minecraft-free)        │
├─────────────────────────────────────────────────────────┤
│  persistence/  SQLite repositories                      │
└─────────────────────────────────────────────────────────┘
                          │
                  environment/minecraft/
                  adapter + bridge client
                          │
                  minecraft-mcp Paper plugin
                          │
                      Minecraft
```

The rule that keeps this honest: **nothing above `environment/` may mention a
block ID, a Bukkit concept, or a bridge command.** The core speaks
`ResourceKind`, `Position`, `StructureBlueprint`. The Minecraft adapter is the
only place `oak_log` and `forceload` appear. A test enforces this by grepping
the core tree for Minecraft vocabulary.

## 2. The causal chain

This is the project's central invariant, and most of the architecture exists to
serve it:

```
need / civilization objective
   → goal              (why the agent is doing anything)
   → plan              (structured, inspectable steps)
   → resource requirement
   → acquisition       (real world mutation)
   → execution         (real world mutation)
   → verification      (re-read the world; C5 means writes can silently fail)
   → event             (append-only ledger entry)
   → memory            (what the agent now knows, and how it learned it)
   → chronicle         (narrative strictly derived from the ledger)
```

Every link is a real record. Consequences we hold ourselves to:

- An agent cannot build with resources it never gathered — the resource ledger
  is debited, and gathering means blocks that actually existed were actually
  removed ([ADR-0004](adr/0004-resource-ledger.md)).
- An agent cannot know a location it never observed or was never told about.
  Knowledge is per-agent, and every knowledge row carries a source
  ([ADR-0007](adr/0007-knowledge-boundaries.md)).
- A relationship never changes without an event explaining why.
- The chronicle generator is handed events and *only* events; it has no channel
  through which to invent one ([ADR-0009](adr/0009-grounded-chronicle.md)).

## 3. Where the LLM is and isn't

The LLM is a decision-maker, never a puppeteer. Deterministic code does all
repetitive work.

**Reasoning is invoked at exactly these points** (each a named category, so cost
is attributable):

| Category | Trigger | Output |
|---|---|---|
| `goal_selection` | no active goal, or active goal blocked/completed | chosen goal + reason |
| `replanning` | a plan step failed and deterministic recovery didn't apply | revised plan or goal abandonment |
| `message_interpretation` | inbound message from another agent | knowledge/plan updates, optional reply |
| `reflection` | every N stored episodic memories | higher-level beliefs |
| `consolidation` | memory count over threshold | merged/summarised memories |
| `chronicle` | end of simulated day | prose for that day's events |

**Everything else is deterministic**: need decay and prioritisation, plan step
advancement, pathable-terrain checks, blueprint computation, block placement,
verification, resource accounting, event writing, memory storage, retrieval
scoring, relationship arithmetic, division-of-labour claim checks.

A `HeuristicProvider` implements every reasoning call with rules instead of a
model. The whole simulation runs, end to end, with no API key — which makes CI
real and gives contributors a zero-cost path in
([ADR-0006](adr/0006-reasoning-provider.md)).

## 4. Agent lifecycle

One tick, as a state machine ([ADR-0001](adr/0001-agent-execution-model.md)):

```
OBSERVE ──► INTEGRATE ──► ASSESS ──► PLAN ──► ACT ──► RECORD ──► (idle)
   │            │            │         │       │        │
 adapter     knowledge    needs +    planner  executor  events +
 snapshot    + memory     goal       (LLM if  (deter-   memory +
 (bounded)   updates      state      needed)  ministic) reflection
```

Most ticks pass straight through `ASSESS` and `PLAN` — an agent with a healthy
active plan just advances one step. LLM calls happen on the exceptions.

Ticks are `async` and interleaved. An agent waiting on a slow model call does
not stall the others ([ADR-0005](adr/0005-scheduler-and-locks.md)).

## 5. Domain model

Persisted shape, abbreviated. Full schema in `src/persistence/schema.sql`.

```
Agent          id, name, personality{}, skills{}, position, health,
               status, current_goal_id, embodiment
Need           agent_id, kind(food|safety|shelter|energy|social), value, decay_rate
Goal           id, agent_id, kind, params{}, state, priority, parent_goal_id,
               reason, created_at, resolved_at
Plan           id, goal_id, steps[], current_step, state
PlanStep       action, params{}, status, attempts, failure
Memory         id, agent_id, type(working|episodic|semantic|relationship),
               content, importance, source, related_entities[], confidence,
               created_at, last_accessed_at, access_count, consolidated_into
KnownLocation  agent_id, position, kind, confidence, source, discovered_at,
               last_seen_at
KnownResource  agent_id, resource, position, est_quantity, confidence, source
Relationship   agent_id, other_id, trust, affinity, familiarity, last_event_id
Message        id, sender_id, recipient_id, content, sent_at, read_at
Resource       agent_id | settlement_id, resource, quantity   (the ledger)
Settlement     id, name, founding_day, objective, status
Structure      id, type, region, builders[], purpose, state, created_at
Project        id, settlement_id, kind, requirements{}, claims[], state
Event          id, seq, type, day, actor_id, payload{}, importance, created_at
Decision       id, agent_id, event_id, observations{}, memories[], prompt,
               response, model, tokens{}, chosen_action   (the audit trail)
LlmCall        id, category, model, input_tokens, output_tokens, cost, agent_id
```

`Decision` is what makes "why did Mira abandon the farm project?" answerable:
the observations, the retrieved memories, the exact prompt, and the model's
response are all persisted next to the resulting event
([ADR-0008](adr/0008-debuggable-causality.md)).

## 6. Environment port

Minecraft-free interface the core codes against:

```ts
interface Environment {
  describe(): EnvironmentInfo
  observe(agent: AgentView, radius: number): Promise<Observation>
  surveyRegion(region: Region, resolution: number): Promise<TerrainSurvey>
  inspect(position: Position): Promise<BlockInfo>
  moveAgent(agent: AgentView, to: Position): Promise<MoveResult>
  harvest(agent: AgentView, target: Region, resource: ResourceKind): Promise<HarvestResult>
  build(blueprint: Blueprint, region: Region): Promise<BuildResult>
  worldTime(): Promise<WorldTime>
  reserveRegion(region: Region, agentId: string): Promise<boolean>
  releaseRegion(region: Region, agentId: string): Promise<void>
}
```

Every method returns a typed result carrying success *or* a structured
`ActionFailure` — never a thrown string. Failures are data the planner reads
([ADR-0008](adr/0008-debuggable-causality.md)).

Two implementations: `MinecraftEnvironment` (bridge-backed) and
`FakeEnvironment` (in-memory voxel grid, used by every test — the whole
simulation is runnable with no Minecraft server at all).

## 7. Persistence

Single SQLite file via `node:sqlite`, no dependencies
([ADR-0010](adr/0010-persistence.md)). Repositories per aggregate; the event
table is append-only and is the authoritative history. A restart rehydrates
agents from their rows and resumes mid-plan.

## 8. Module layout

```
src/
  core/           ids, clock, result types, config
  agents/         agent, runtime (the tick state machine), needs, skills
  goals/          goal, plan, planner, actions/ (deterministic executors)
  memory/         store, retrieval, consolidation, relationships
  civilization/   settlement, projects, coordination
  environment/    port.ts, fake/, minecraft/{adapter,bridge-client,blueprints}
  reasoning/      provider.ts, anthropic.ts, heuristic.ts, scripted.ts,
                  prompts/, structured.ts
  events/         types.ts, store.ts
  chronicle/      generator.ts
  scheduler/      runtime.ts, locks.ts
  persistence/    db.ts, schema.sql, repositories/
  observability/  logger.ts, views.ts, metrics.ts, causality.ts
  scenarios/      first-settlement.ts
  cli/            worldloom run | inspect | chronicle | events
```

`observability/` holds the read side, and it does no formatting: `views.ts`,
`metrics.ts` and `causality.ts` are pure functions from a `Store` to
JSON-serialisable structures. The CLI renders them; a local web UI can serve the
same objects over the wire without a second query layer (requirement 24).

## 9. Decisions

| ADR | Decision |
|---|---|
| [0001](adr/0001-agent-execution-model.md) | Agents are async state machines, not actors |
| [0002](adr/0002-connect-via-bridge.md) | Connect to the WebSocket bridge, not MCP stdio |
| [0003](adr/0003-agent-embodiment.md) | Agents are logical entities with visible markers |
| [0004](adr/0004-resource-ledger.md) | Worldloom owns inventory; gathering is real block removal |
| [0005](adr/0005-scheduler-and-locks.md) | Interleaved ticks, concurrency cap, region reservations |
| [0006](adr/0006-reasoning-provider.md) | Provider abstraction with a no-LLM heuristic implementation |
| [0007](adr/0007-knowledge-boundaries.md) | Per-agent knowledge, enforced by repository shape |
| [0008](adr/0008-debuggable-causality.md) | Persist observations, memories, prompts and outcomes per decision |
| [0009](adr/0009-grounded-chronicle.md) | Chronicle is generated only from ledger events |
| [0010](adr/0010-persistence.md) | SQLite via `node:sqlite`, behind a thin port |
| [0011](adr/0011-world-time.md) | Minecraft time is authoritative; sim ticks are decoupled |
