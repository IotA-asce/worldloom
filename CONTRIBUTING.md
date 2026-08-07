# Contributing to Worldloom

Thanks for looking. Worldloom is early — the architecture is settled but most of
the runtime isn't written, so there is a lot of well-specified work available.

## Getting set up

```bash
npm install
npm run typecheck
npm test
```

Requires Node ≥ 22.5 for the built-in `node:sqlite`. Nothing else — no
Minecraft server, no API key, no native build. If `npm test` doesn't pass on a
clean clone, that's a bug worth reporting on its own.

To run against a real world you additionally need
[`minecraft-mcp`](https://github.com/IotA-asce/minecraft-mcp)'s Paper server
running; see [docs/minecraft-integration.md](docs/minecraft-integration.md).

## Where to start

[docs/v0-plan.md](docs/v0-plan.md) lists the V0 work as issue-sized tasks in
dependency order. Tasks in the current milestone are the useful ones; tasks in
later milestones will likely need rework as earlier ones land.

Read [docs/architecture.md](docs/architecture.md) first, and the
[ADRs](docs/adr/) for anything that looks like an arbitrary choice — it usually
isn't, and the reasoning is written down.

## The five rules that matter

**1. Minecraft stays out of the core.** Nothing above `src/environment/` may
reference a block ID, a Bukkit concept, or a bridge command. If your feature
seems to need `oak_log` in `src/agents/`, the missing piece is a normalised
concept on the `Environment` port. A test enforces this.

**2. Don't break a causal chain.** If an agent knows something, an observation
or a message must explain how. If it builds something, resources must have been
debited from a ledger that was credited by verified world changes. If a
relationship moves, an event must say why. Shortcuts here are the difference
between a simulation and a demo — see §47 of the requirements and
[ADR-0004](docs/adr/0004-resource-ledger.md).

**3. Prefer deterministic code to model calls.** The LLM picks goals, interprets
novelty, reasons socially, reflects and summarises. Everything repetitive is
code. Adding a new reasoning call means adding a category, a schema, *and* a
`HeuristicProvider` implementation — if you can't write the rule-based version,
the decision probably isn't well specified yet.
([ADR-0006](docs/adr/0006-reasoning-provider.md))

**4. Make it inspectable.** New state should be reachable from the CLI. New
decisions should write a `decisions` row. "Why did this happen?" must be
answerable from the database, not from reading console output.

**5. Failures are values, not exceptions.** Environment and action failures
return a typed `ActionFailure` that the planner can react to. Don't paper over a
failure with retries — bounded retries only, and only where the operation is
idempotent. ([ADR-0008](docs/adr/0008-debuggable-causality.md))

## Tests

Deterministic components need real tests: need prioritisation, goal state
transitions, plan execution, memory insert/retrieve/consolidate, relationships,
message handling, event persistence, restart persistence, adapter contract,
structured-output validation, failed-action handling.

- Use `FakeEnvironment` (in-memory voxel world), not a Minecraft server.
- Use `ScriptedProvider` (fixtures) or `HeuristicProvider` for reasoning.
- **No test may require a live paid API call.** CI has no key.
- Adapter changes should also pass the shared contract test, which runs the same
  assertions against both `FakeEnvironment` and `MinecraftEnvironment`; the
  Minecraft half is skipped unless `WORLDLOOM_BRIDGE_URL` reachable.

## Style

TypeScript, ESM, `strict` plus `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes`. Match the surrounding code. Comments explain *why*,
not *what* — the code already says what.

Keep dependencies close to zero. We use `ws`, `zod`, `yaml` and the Anthropic
SDK. A PR adding a dependency should say in one line why the alternative was
worse.

## Commits and PRs

One logical change per PR, with a short description of what changed and how you
verified it. If you made an architectural decision, add an ADR in `docs/adr/`
following the existing format (context, decision, alternatives rejected,
consequences) — including the alternatives, which is the part that's actually
useful later.

## Reporting bugs

For simulation misbehaviour, the useful report includes what the agents did,
what you expected, and the relevant rows: `worldloom why <agent>`,
`worldloom events --day N`. Those are the artifacts observability exists to
produce.
