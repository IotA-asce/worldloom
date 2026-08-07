# ADR-0011 — Minecraft time is authoritative; sim ticks are decoupled

**Status:** accepted · **Date:** 2026-08-07

## Context

Requirement 44 asks how Worldloom ticks map to Minecraft time. Two clocks exist
and they run at unrelated rates: a Minecraft day is 24000 ticks ≈ 20 minutes of
wall clock, while a Worldloom agent tick involves bridge round trips and
sometimes a multi-second model call. Needs decay and "night is coming, build
shelter" must key off the world the agents actually inhabit.

## Decision

**The world clock is authoritative for narrative time.** `get_time_weather`
gives `time_ticks` and `is_day`; Worldloom derives:

```
world_day  = floor(total_elapsed_ticks / 24000)
day_phase  = dawn | day | dusk | night     (from time_ticks)
```

Because `time_ticks` wraps each day, the adapter tracks wraparound to maintain a
monotonic total, persisted so it survives restart. `world_day` is what events,
chronicle entries, and needs use. "Day 4" in the chronicle means the fourth
Minecraft day the civilization lived through.

**The agent tick is a separate, decoupled cadence.** Default one tick per agent
every ~2 s of wall clock, tuned by config. Ticks are *not* counted as time; they
are how often an agent gets a chance to think.

**Needs decay against world time, not tick count.** Hunger advances with elapsed
world ticks, so an agent whose ticks are slowed by a busy scheduler doesn't
become immortal — which a naive per-tick decay would cause.

**Time control is a scenario affordance, not a simulation input.** A scenario may
set `time_scale`, using `set_time` to advance the world faster so a multi-day
demo doesn't take hours. The simulation reads the clock either way and cannot
tell the difference.

## Alternatives rejected

- **Worldloom tick as the master clock** — Worldloom's own counter would be
  simple and would let agents drift out of sync with the visible world: an agent
  building at "midday" while Minecraft is dark. It also makes needs decay depend
  on scheduler load, which is a correctness bug.
- **Wall-clock time as authoritative** — decouples from what agents observe, and
  breaks when a scenario accelerates the world.
- **Blocking until a Minecraft day boundary** — wastes minutes doing nothing.

## Consequences

- Day/night behaviour is genuinely reactive: agents seek shelter because the
  world is actually getting dark.
- Chronicle day numbers correspond to real Minecraft days, so a screenshot and
  a chronicle entry agree.
- Accelerated time in demos is safe and requires no simulation changes.
- The monotonic-tick tracker is a small piece of stateful bookkeeping that must
  be persisted and unit-tested for wraparound, including across restart.
