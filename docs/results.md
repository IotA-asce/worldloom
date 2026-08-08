# V0 results — First Settlement

The honest record of the V0 target: five persistent autonomous agents establish
a self-sustaining settlement. Everything below comes out of two artifacts that
anyone can regenerate — the acceptance suite (`test/v0-acceptance.test.ts`) and
a thirty-day soak of the shipped demo scenario — plus a plain list of what
still goes wrong.

```
npm test                                                    # 629 tests, 7 §35 criteria
npm run dev -- run --config scenarios/first-settlement.yaml # the soak, ~10 minutes, $0
```

The soak ran at commit `dcba029`, seed 3, fake environment, heuristic provider:
**no model calls, no API key, no spend.** That is deliberate — the demo must
prove the simulation, not the budget (requirement: LLM-dependent tests avoid
live paid calls). The Anthropic provider is the upgrade path, not the
requirement.

## The success criteria (§35), each with its evidence

| Criterion | Where it is proven |
|---|---|
| Five settlers alive and working through several days | acceptance: *keeps five settlers alive and working*; soak: 5 of 5 alive on day 30, 31,624 events |
| A settlement founded, a structure standing in it | acceptance: *founds a settlement and verifies a structure stands*; soak: Aurelian Reach with shelter, storage and farm, all `complete` |
| Division of labour, not five identical workers | acceptance: *divides labour*; soak: 847 `assist_agent`, 1,497 `explore_region`, 412 `find_food` completions spread across roles |
| Knowledge spreads by being told; the past is remembered | acceptance: *spreads knowledge by being told*; soak: 967 messages, 3,966 memories consolidated to 141 living |
| Recovery from failure, not repetition forever | acceptance: *recovers from failure*; soak: replans replace abandoned goals (see the failure table — every chronic failure has a recovery path) |
| Survives a restart with history intact | acceptance: *survives a restart* (a real file-database kill-and-resume) |
| A chronicle grounded entirely in the event ledger | acceptance: *produces a chronicle grounded entirely in the event ledger*, including a fabricated sentence the verifier rejects; soak: `worldloom chronicle --generate` below |

The acceptance suite runs all seven against **one shared 800-round world**,
because the criteria are about the same run: the agents who divide labour are
the ones who remember, replan, and survive the restart.

## The thirty-day soak, in numbers

| | |
|---|---|
| Days simulated | 30 (720,000 ticks) |
| Events in the ledger | 31,624 |
| Decisions | 4,419 — all rule-based |
| Messages between agents | 967 |
| Memories | 3,966 recorded, 141 living after consolidation |
| Places explored | 2,290 across 1,574,856 blocks surveyed |
| Structures | shelter (−148, 72, −128), storage (−92, 70, −22), farm (−96, 70, −13) — three distinct sites, all day 0, all verified complete |
| Settlement stores at day 30 | 1,546 wood · 175 stone · 70 soil · 7,102 food |
| Cost | $0.00 — `worldloom costs` reports "no model calls" |

Goal outcomes over the month:

| kind | completed | abandoned |
|---|---:|---:|
| seek_shelter | 917 | 26 |
| explore_region | 1,497 | 0 |
| assist_agent | 847 | 0 |
| find_food | 412 | 568 |
| gather_resource | 27 | 6 |
| build_structure | 3 | 4 |
| rest | 77 | 0 |

## The chronicle the soak produced

`worldloom chronicle --generate`, unedited:

> **Day 0: the first day** — the settlement of Aurelian Reach was founded at
> (−64, 70, −48)… Arun completed the shelter at (−148, 72, −128) on day 0, for
> somewhere safe to sleep. Arun completed the storage at (−92, 70, −22) on day
> 0, for keeping the settlement's supplies. Sam completed the farm at
> (−96, 70, −13) on day 0, for growing food.
>
> **Day 30: work finished** — Mira reworked their plan into 6 step(s) on day
> 30: I cannot reach it from here… Arun asked for help with find food on day
> 30: no food visible within 80 blocks.

Every name, place, date and deed resolves to real rows in the event ledger —
that is the chronicle's one non-negotiable rule, and the verifier test feeds it
a fabricated sentence to prove the rejection path works.

## What still goes wrong — the honest list

- **Foraging churns.** 568 of 604 abandoned goals are `find_food`, failing
  ~22 times a day, every day, on `RESOURCE_UNAVAILABLE` — "no food visible
  within 80 blocks". The settlers eat out the land around the settlement and
  the search widens noisily instead of rotating through known grounds. Nobody
  starves (7,102 food in store), but a fifth of all decisions are spent
  re-answering "where did the berries go". This is the clearest V1 target.
- **One settler still wedges in terrain pockets.** 27 of the last 50 failures
  are Mira, `PATH_BLOCKED` on the same journey across days 29–30. The router
  escapes dead ends and the replanner abandons and retries — she recovers each
  time and re-wedges later. Rarer than it was (the stall ceiling is now
  progress-aware), not gone.
- **The chronicle is thin after founding.** Two entries cover thirty days:
  the founding flurry crosses the importance bar, steady work does not. Nothing
  invented is the floor, not the ceiling — V1 should tune importance so a
  month of labour reads like more than a footnote.
- **The Minecraft adapter is unproven at this scale.** Every number above is
  from the in-memory environment. The adapter is built and unit-tested against
  a mock bridge, but no thirty-day run has yet executed against a live server;
  R2 (silent fill failures) and R3 (bridge kicks) are mitigations on paper
  until one has. That run is the first item of V1.
- **`build_structure` abandoned 4 times** after the three structures stood —
  duplicate rebuild goals that correctly lost the claim race and stood down.
  Harmless, but the planner should stop proposing what already exists rather
  than abandoning it mid-attempt.

## What the soak fixed along the way

The soak's job was to break things, and it did. The worst was the settlement's
only shelter standing complete and verified while **511 seek_shelter goals died
PATH_BLOCKED against its wall** — the clear step dug a two-block moat around
every build site and the doorway was unclimbable. The fix (siting builds flush
with the ground, refuses ledges, and clearing never digs below the base layer)
is `dcba029`, with regression tests that build the hut and walk in through the
door. This run is the proof: 917 shelter-seek completions against 26 early
abandonments, all of those on days 0–1 before the shelter stood.
