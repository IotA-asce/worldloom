# Minecraft Integration

How Worldloom talks to Minecraft, what the existing
[`IotA-asce/minecraft-mcp`](https://github.com/IotA-asce/minecraft-mcp) project
gives us, and — more importantly — what it *doesn't*.

Findings below are from inspecting `minecraft-mcp` at commit `1fcd04b`
(`docs/bridge-protocol.md`, `src/bridge.ts`, `src/tools/*`,
`plugin/src/main/java/com/iotaasce/mcp/*`, `scripts/lib-build.ts`).

## 1. The existing stack

```
AI harness (Claude Code / Codex)
   │  stdio, MCP protocol
   ▼
minecraft-mcp  src/            Node + TypeScript MCP server
   │  WebSocket, one JSON frame per message
   ▼  ws://127.0.0.1:8765
minecraft-mcp  plugin/         Java Paper plugin `minecraft-mcp-bridge`
   │  Bukkit/Paper API, main-thread scheduled
   ▼
PaperMC server
```

Two separable pieces live in that repo:

1. **The Paper plugin** — the substantial, hard-to-replace artifact. It owns
   every actual world mutation and query, marshalled onto the Bukkit main
   thread.
2. **The MCP server** — a thin stdio↔WebSocket translator that re-exports each
   bridge command as an MCP tool with a Zod schema.

The durable contract between them is `docs/bridge-protocol.md`: JSON request
frames `{id, cmd, args}`, exactly one response `{id, ok, result|error}` per
request, plus unsolicited event frames.

## 2. Available command surface

All commands take an optional `player`, defaulting to the first online player.
Coordinates are doubles; block/item names are lowercase Bukkit material keys
(`oak_log`, `cobblestone`).

| Group | Commands | Player required? |
|---|---|---|
| Movement | `look_at`, `move_to`, `jump`, `sprint`, `sneak`, `stop` | **yes** |
| Interaction | `break_block`, `place_block`, `use_item`, `attack`, `interact_entity` | `break_block`/`place_block` **no**; rest yes |
| Inventory | `get_inventory`, `equip_item`, `drop_item`, `swap_hands` | **yes** |
| Info | `get_player_state`, `get_block_at`, `get_heightmap`, `get_nearby_entities`, `get_time_weather` | only `get_player_state`, `get_nearby_entities` |
| Chat | `send_chat` | **yes** |
| Admin | `teleport`, `set_gamemode`, `give_item`, `set_time`, `set_weather`, `summon_entity`, `run_command` | `set_time`/`set_weather`/`run_command` **no**; `summon_entity` no *if* explicit coords |

Error codes: `PLAYER_NOT_FOUND`, `BAD_ARGS`, `NO_PLAYER_ONLINE`, `TIMEOUT`,
`UNSUPPORTED`, `INTERNAL`.

Events pushed by the plugin: `hello`, `player_join`, `player_quit`,
`player_chat`, `player_death`.

The two commands that matter most for autonomous agents:

- **`get_heightmap {x0, z0, x1, z1, step?}`** — samples the highest non-air
  block on a grid (step 1–32, max 16384 cells). This is the primary sensor: it
  turns terrain into cheap structured data. `minecraft-mcp`'s own
  `survey-terrain.ts` uses it to pick real build sites.
- **`run_command`** — console access, so `fill`, `forceload`, `tp`,
  `data merge` are all reachable. This is what makes bulk building and
  player-less operation practical.

## 3. Constraints that shape Worldloom's design

These are the findings that actually changed the architecture. Each one is a
hard property of the current bridge, verified in its source or docs.

### C1 — There is no NPC. The bridge controls *online players*.

> "Controls an online player; fake-player NPCs are future work."
> — `minecraft-mcp` README, known limitations

There is no server-side agent entity to embody. Five Worldloom agents cannot
become five Minecraft players without running five real Minecraft clients.
This is the single most consequential constraint; see
[ADR-0003](adr/0003-agent-embodiment.md).

### C2 — Player-less operation works, and is the way in.

World-level commands work against the default world with *nobody* online:
`place_block`, `break_block`, `get_block_at`, `get_heightmap`,
`get_time_weather`, `set_time`, `set_weather`, `run_command`, and
`summon_entity` with explicit coordinates. That is a complete sense-and-mutate
loop with no player. Worldloom's V0 lives here.

What is lost without a player: real movement, real inventory, chat as a player,
teleport/gamemode/give. Worldloom must therefore own movement and inventory as
simulation concerns rather than reading them out of Minecraft
([ADR-0003](adr/0003-agent-embodiment.md), [ADR-0004](adr/0004-resource-ledger.md)).

### C3 — The bridge accepts exactly one client. Newest wins.

> "if a second connects, the newest wins and the old one is closed"
> — bridge protocol, Transport

`minecraft-mcp`'s own build library documents the operational consequence:

> "the bridge plugin accepts only ONE client at a time and kicks the older one
> ('replaced by newer client'), so a harness MCP server reconnecting mid-build
> will drop a long-running script's socket"
> — `scripts/lib-build.ts`

Implications, both real:

- **You cannot run Worldloom and an MCP-connected harness against the same
  server at once.** They will fight over the socket. Documented in the README
  as an operational rule.
- Worldloom must treat connection loss as *expected*, not exceptional. The
  adapter reconnects with backoff and retries only **idempotent** commands
  (`get_*`, `fill`, `forceload`). Non-idempotent commands (`break_block`,
  `give_item`) fail up to the planner instead of being silently re-sent.

### C4 — `move_to` is steering, not pathfinding.

Velocity-based: it faces the target and holds forward, hopping 1-block
obstacles. It will not route around a wall. Worldloom cannot rely on it for
navigation even in piloted mode; long traversal is Worldloom's problem.

### C5 — Console `fill` fails silently on unloaded chunks.

With nobody online, chunks unload and `fill` no-ops without erroring. Every
build must `forceload add` its region first and release afterwards. **A silent
failure mode means writes must be verified, not assumed** — the adapter samples
`get_block_at` after building. This is also why Worldloom's causal chain ends
in *verification* rather than in the place call.

### C6 — `fill` is capped at 32768 blocks per command.

Large volumes must be split. `lib-build.ts` already solves this by recursive
bisection along the longest axis; that logic is worth porting rather than
reinventing.

### C7 — Timeouts are layered.

The plugin answers long commands (`move_to`, survival `break_block`) on the
same id when finished; the MCP server applies an outer timeout (30 s for
`move_to`, 10 s otherwise). Worldloom applies its own per-command deadline and
surfaces expiry as a typed action failure.

### C8 — Survival `break_block` uses a fixed 1 s delay.

Regardless of tool or block hardness. Breaking 48 logs one at a time costs
~48 s of wall clock. For bulk resource gathering Worldloom uses console
`fill ... air` over a verified volume and credits the ledger for what was
actually removed, rather than 48 sequential `break_block` calls.

## 4. How Worldloom connects: bridge protocol, not MCP stdio

Worldloom speaks the **WebSocket bridge protocol directly** and does not run
`minecraft-mcp`'s MCP server. See [ADR-0002](adr/0002-connect-via-bridge.md).

Short version: MCP is an *LLM harness* interface — it wraps every result in
text content blocks and adds a JSON-RPC hop over a subprocess pipe. Worldloom
is a program, not a harness; it wants typed results. The bridge protocol is the
real API and is explicitly specified as a stable contract, so targeting it is
the lower-coupling choice, not a shortcut around the dependency.

What we reuse from `minecraft-mcp`:

- **The Paper plugin, unchanged** — all world authority. This is the dependency
  that matters, and Worldloom adds nothing to it for V0.
- **The protocol contract** in `docs/bridge-protocol.md`.
- **Proven algorithms** from `scripts/lib-build.ts`: chunked `fill` bisection,
  last-wins block dedupe, carve-after-place ordering, forceload bracketing,
  post-build verification sampling, and idempotent-retry-on-disconnect.

What Worldloom implements itself: a ~200-line typed bridge client
(`src/environment/minecraft/bridge-client.ts`) matching the documented frame
format. `minecraft-mcp` publishes no library entrypoint (`package.json` exposes
only a `bin`), so importing its `MinecraftBridge` class would mean depending on
an unpublished package's internal file paths and build output. Reimplementing
the documented wire format is *less* coupled than that.

## 5. Missing capabilities

Needed for the full Worldloom vision, absent today. None block V0.

| Gap | Impact | V0 workaround |
|---|---|---|
| No NPC/fake-player entity | Agents have no body | Logical embodiment + visible marker entity (ADR-0003) |
| No pathfinding | Can't navigate terrain | Heightmap-based traversal validation in the adapter |
| Single bridge client | No concurrent consumers | One Worldloom process multiplexes all agents |
| No block-search command | Finding ore means sampling block-by-block | `get_heightmap` for surface; console `clone`-free probing for depth; bounded scans |
| No per-entity inventory | No real agent inventory | Worldloom resource ledger (ADR-0004) |
| No event for block change | Can't detect another actor's edits | Verify-before-build; region reservations |
| Bulk block query | `get_block_at` is one block per round trip | Batch via `get_heightmap` where a surface answer suffices |

The most valuable upstream contributions would be a **bulk block query**
(`get_blocks` over a volume) and a **block-change event**. Both are additive to
the plugin and would cut Worldloom's round trips substantially. Filed as
follow-up work, not V0 scope.

## 6. Running the pair locally

```bash
# in minecraft-mcp/
node scripts/setup-server.mjs 26.2   # once: download Paper, accept EULA
npm run start:server                 # builds + installs plugin, launches server

# in worldloom/
export WORLDLOOM_BRIDGE_URL=ws://127.0.0.1:8765   # default
npm run dev -- run scenarios/first-settlement
```

Worldloom needs no Minecraft client connected and no player online. Join the
server with a client if you want to *watch* — but see C3: do not point an
MCP harness at the same bridge while Worldloom is running.
