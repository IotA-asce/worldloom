# Worldloom

A simulation framework for **persistent autonomous AI civilizations**.

A group of agents inhabits a shared world. They observe it, remember what
happens, decide for themselves what to do, talk to each other, coordinate, fail,
recover, and gradually build something — while a durable event ledger records
how it all actually happened.

Minecraft is the first environment Worldloom plugs into. It is not what
Worldloom is about; it is simply somewhere visible for these processes to
happen.

> **Status: V0 runs, end to end.** Five agents observe a world, set themselves
> goals, plan, gather verified resources, found a settlement, build and verify
> structures together, talk, remember what happened, replan when they fail, and
> resume after a restart — and the run ends in a chronicle whose every sentence
> cites the ledger. All seven V0 success criteria run as one acceptance test
> (`node --test --import tsx test/v0-acceptance.test.ts`), and the whole thing
> works with **no API key** via the rule-based provider.
>
> The honest numbers, including what still doesn't work, are in
> [docs/results.md](docs/results.md); the milestone history is in
> [docs/v0-plan.md](docs/v0-plan.md).

## Why it exists

Most "AI agent" demos are stateless: a model is prompted, it emits an action,
the transcript is discarded. Nothing accumulates. There is no history, no
society, and no way to ask why anything happened.

Worldloom is an attempt at the opposite — a substrate where **persistence,
agency, causality and emergence** are the primary features:

- an agent knows things because it observed them or was told them, and every
  belief records which
- an agent builds something because it set a goal, planned it, and acquired the
  materials — the causal chain is stored, not narrated
- an agent's opinion of another changes because of an event that exists in the
  ledger
- the history you can read at the end is derived from that ledger and cannot
  contain anything that didn't happen

## What it is not

Being direct about the current design, because it's the first thing worth
knowing:

- **V0 agents are not Minecraft players.** The underlying bridge controls
  whoever is logged in and has no NPC support, so five agents cannot be five
  players without five Minecraft clients. Worldloom agents are logical entities
  that observe and modify a real Minecraft world; their movement is validated
  against real terrain, their construction is real and verified, and each has a
  visible marker entity you can watch. Their *bodies* are bookkeeping.
  ([ADR-0003](docs/adr/0003-agent-embodiment.md))
- **It is not an LLM puppeteering a game.** The model picks goals, interprets
  situations, reasons socially and reflects. Deterministic code does all the
  repetitive execution. The whole simulation also runs with **no model at all**
  via a rule-based provider — which is how the tests work.
  ([ADR-0006](docs/adr/0006-reasoning-provider.md))
- **It is not a chatbot roleplay.** Agents have needs, resource balances they
  must actually earn, and plans that genuinely fail.

## Architecture

```
Worldloom
  ├── Civilization runtime      settlement, projects, coordination
  ├── Agent runtime             tick state machine: observe → plan → act → record
  ├── Memory                    episodic, semantic, relationships, consolidation
  ├── Goals & planning          structured, inspectable, persisted plans
  ├── Communication             messages as first-class simulation events
  ├── Event ledger              append-only; the authoritative history
  └── Chronicle                 narrative generated strictly from the ledger
              │
              ▼
      Environment port          Minecraft-free interface
              │
              ▼
      Minecraft adapter  ──►  minecraft-mcp Paper plugin  ──►  Minecraft
```

Nothing above the environment port may mention a block ID or a Bukkit concept.
That boundary is what lets Godot, Webots or a custom simulation become the
second environment without touching agent logic.

Full detail in [docs/architecture.md](docs/architecture.md); every non-obvious
decision is an [ADR](docs/adr/).

## Relationship to minecraft-mcp

Worldloom sits **above** [`IotA-asce/minecraft-mcp`](https://github.com/IotA-asce/minecraft-mcp)
and reuses it rather than reimplementing Minecraft control.

That project contains a Paper plugin exposing world observation and mutation
(heightmaps, block queries, placement, removal, console commands, and
player-less operation) plus an MCP server for LLM harnesses. Worldloom uses
**the plugin, unchanged**, speaking its documented WebSocket bridge protocol
directly — it does not run the MCP server, because Worldloom is a program that
wants typed results rather than a harness that wants tool calls.
([ADR-0002](docs/adr/0002-connect-via-bridge.md))

What the constraints of that layer are, and how they shaped this design, is
written up in
[docs/minecraft-integration.md](docs/minecraft-integration.md) — worth reading
before contributing to the adapter.

## Running it

Requires **Node ≥ 22.5** (developed on 24; uses the built-in `node:sqlite`).

```bash
npm install
npm test          # full simulation, fake environment, no API key, no Minecraft
```

The fastest way to watch a civilization run — no server, no key, no spend,
about ten minutes for thirty days:

```bash
npm run dev -- run --config scenarios/first-settlement.yaml
```

Against a real world, start the Paper server from `minecraft-mcp` first:

```bash
# in minecraft-mcp/
node scripts/setup-server.mjs 26.2   # once
npm run start:server

# in worldloom/
cp worldloom.example.yaml worldloom.yaml
export ANTHROPIC_API_KEY=...          # optional; omit to run rule-based
npm run dev -- run scenarios/first-settlement
```

No Minecraft client and no player need to be online. Join the server if you want
to watch — but do not point an MCP harness at the same server while Worldloom is
running: the bridge accepts one client and the newest connection kicks the older
one.

Inspect a running or finished civilization (point `--config` at whatever the
run used):

```bash
npm run dev -- inspect --config scenarios/first-settlement.yaml
npm run dev -- why mira --config scenarios/first-settlement.yaml
npm run dev -- events --day 4 --config scenarios/first-settlement.yaml
npm run dev -- chronicle --generate --config scenarios/first-settlement.yaml
npm run dev -- costs --config scenarios/first-settlement.yaml
```

## Example output

Real output from a rule-based run (no model calls), lightly trimmed:

```
Aurelian Reach founded — Establish a self-sustaining settlement
  Arun (Explorer) arrived        ... Mira (Builder), Nadia (Forager),
                                     Elias (Gatherer), Sam (Miner)

Sam decided to gather 60 wood — the settlement still has no permanent
  shelter, and I need 60 more wood to build one
Sam: found wood near (-79, 73, -62)
Sam: travelled 79 blocks
Sam: gathered 60 wood (verified from 16 samples)
Sam decided to gather 25 stone — ... I need 25 more stone to build one
Sam: gathered 25 stone (verified from 25 samples)
Sam: chose a site at (-64, 68, -8)
Sam: claimed the site
Sam: cleared 80 blocks of ground
Sam: built the shelter at (-64, 68, -8)
Sam: the shelter stands, verified from 19 samples

Mira failed: [RESOURCE_UNAVAILABLE] no food visible within 80 blocks → replan
Mira: ate 4 food
```

Every number there is real: the 60 wood was credited from blocks confirmed
removed from the world, the shelter cost exactly those resources from Mira's
ledger, and the failure genuinely reached the planner.

```
CHRONICLE

Day 1 — Arrival
Five settlers established their first camp overlooking the western bay.

Day 2 — The Northern Ridge
Arun discovered a deposit of exposed iron north of the settlement and
returned with news of the find.
```

Every name, coordinate and day in a chronicle entry is verified against the
events it was generated from. If it isn't in the ledger, it cannot appear.

## Roadmap

**V0 — The First Settlement** (current): five agents, one settlement, memory,
relationships, division of labour, chronicle, restart persistence.
Milestones and issue-sized tasks in [docs/v0-plan.md](docs/v0-plan.md).

**Beyond V0**, in roughly the order the architecture is meant to support:
specialisation → trade → economies → institutions → laws → politics → factions →
culture → history. Plus additional environments (Godot, Unity, Webots) behind
the same port.

Deliberately *not* in V0: reproduction, genetics, large populations,
governments, warfare, currencies, multiple settlements, reinforcement learning.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The most useful things to know: keep
Minecraft out of the core, make new behaviour observable and testable, and don't
break a causal chain — if an agent knows or does something, the ledger must be
able to explain how.

## License

MIT — see [LICENSE](LICENSE).
