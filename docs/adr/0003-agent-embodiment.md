# ADR-0003 — Agents are logical entities with visible markers

**Status:** accepted · **Date:** 2026-08-07

## Context

The requirement asks: should a Worldloom agent map to a real Minecraft player,
an NPC, a server-side logical entity, or something else?

The bridge forces the answer. It controls **whoever is online**, and its README
states plainly that "fake-player NPCs are future work" (constraint C1). There is
no NPC to embody. Five real players would mean five running Minecraft clients
with five accounts — untenable as the default way to run a simulation, and it
would make CI impossible.

Meanwhile, player-less operation (C2) gives a complete sense-and-mutate loop:
`get_heightmap`, `get_block_at`, `place_block`, `break_block`, `run_command`.

## Decision

An agent is a **server-side logical entity owned by Worldloom**. Worldloom holds
its authoritative position; Minecraft holds the world. Two embodiment modes:

- **`logical`** (V0 default) — position is Worldloom state. Movement is
  validated against real terrain via `get_heightmap` before the position
  updates: an agent cannot walk through a mountain or off a cliff, because the
  adapter checks the real height profile along the route and fails the move
  otherwise. World mutation uses the player-less commands. All five agents run
  concurrently with no Minecraft client attached.
- **`piloted`** — one agent is bound to an online player and uses the real
  `move_to`, `get_inventory`, `send_chat`. Useful for demoing embodiment with a
  human watching, and it exercises the same `Environment` port.

Each logical agent gets a **visible marker**: an armour stand with a custom
name, summoned at spawn and repositioned via console `tp` as the agent moves.
Observers can watch the settlement develop and see who is where.

The marker is *presentation only*. No simulation decision reads it. If marker
summoning fails, the simulation continues and logs a warning.

## Alternatives rejected

- **Five real players** — five clients and accounts; impossible in CI.
- **Villagers/mobs as bodies** — they have their own AI and pathing that would
  fight Worldloom's intent, and no inventory access via the bridge.
- **Upstream a fake-player NPC into the plugin first** — the honest long-term
  answer, and a serious piece of Bukkit work (network handler, entity
  tracking). Doing it before Worldloom exists would stall the actual project.
  Logical embodiment makes the simulation real now, and the `Environment` port
  means swapping in true NPCs later touches only the adapter.

## Consequences

- Worldloom must own movement and inventory as simulation concerns
  ([ADR-0004](0004-resource-ledger.md)).
- Agent position is only as truthful as the terrain validation. Traversal
  therefore *queries the world* rather than trusting arithmetic, and every move
  records the survey it was based on.
- Honest framing required in the README: V0 agents are not Minecraft players.
  They observe and modify a real Minecraft world, and their bodies are
  bookkeeping.
- Migration path is clean — `piloted` mode already proves the port works with a
  real body, so a future NPC mode is a third implementation, not a redesign.
