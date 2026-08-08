# Building V0 — the process record

This is how V0 was actually built: the method, the milestones, and — mostly —
the failures, because a simulation's process record *is* its failure record.
Every number below comes out of a test, a commit, or a database a run produced;
where a fix turned out to be for the wrong mechanism, that is recorded too.

The results themselves live in [results.md](results.md). The plan as written
ahead of time lives in [v0-plan.md](v0-plan.md). This document is the third
leg: what happened between the plan and the results.

## 1. Method

Five practices did most of the work.

**A vertical slice before any breadth.** M1 ran one agent through every layer —
observe, goal, plan, verified mutation, memory, restart — before a second agent
existed. Everything after widened a working system rather than assembling parts
that had never run together. Several of the worst bugs the project ever had
(agents forgetting their goal every tick; replanning regenerating the identical
failing plan) were caught in that first slice, when they were cheap.

**A milestone is a merge.** Each milestone ends with a demonstrable behaviour
and passing tests, and lands on `main` as its own branch-commit-merge-push
cycle. The commit history is therefore a readable record of the build:
`48b63b8` scaffold → `885841d` the vertical slice → `edbfbde` memory →
`1b7ee91` five agents → `96f080a` settlement and projects → `dc1df31` the
chronicle → `f1cb305` observability → `6c2e059` the recorded soak.

**Every non-obvious decision is an ADR.** Eleven of them, from agent embodiment
([ADR-0003](adr/0003-agent-embodiment.md)) to the grounded chronicle
([ADR-0009](adr/0009-grounded-chronicle.md)). When a soak later contradicted a
design assumption, the ADR was the record of what had been assumed and why.

**Deterministic code executes; a model, at most, decides.** Plans are data
carried out by deterministic executors; the reasoning provider (a rule-based
one by default, an Anthropic model when configured) only chooses goals,
interprets, and reflects. Consequence: the entire simulation runs with no API
key and no spend, every test is deterministic, and a failure is always
reproducible from the ledger. All 4,419 decisions in the final soak were
answered by rules.

**The database is the evidence.** A behaviour the ledger cannot prove is
treated as not having happened. The acceptance suite asserts against the
database a run produced, not against logs or transcripts — and the chronicle
verifier rejects any sentence whose entities don't resolve to ledger events.

## 2. The verification stack

Four layers, each with a different job.

| Layer | What it proves | Scale |
|---|---|---|
| Unit & integration (`npm test`) | Mechanisms: traversal, harvesting, building, memory, goals, messaging | 629 tests, 140 suites |
| Regression tests | One specific soak failure each; **shown to fail without the fix** before being trusted | woven through the suite |
| Acceptance (`test/v0-acceptance.test.ts`) | The seven §35 success criteria, asserted against the database of one shared 800-round world | ~2.5 minutes |
| The soak | Everything nobody thought to test | 30 days, 720,000 ticks |

Two disciplines deserve emphasis because they did disproportionate work:

**A regression test must fail without its fix.** Both siting regressions added
in the final week were verified this way — one by disabling the fix in source
and watching the test go red, one by building the old stacked-floor variant in
a scratch world and watching the agent stop one block short of the door. A test
that passes against the broken behaviour proves nothing and costs confidence.

**The soak's job is to break things.** Each soak ended in the failures table,
not the success summary: `worldloom failures` sorted by kind, then the ledger
query that explains the top entry, then a fix, then a rerun. Section 4 is that
loop, iterated.

## 3. Milestones, and what each flushed out

**M0 — architecture and scaffold.** Eleven ADRs, the repository, CI. The
decision that mattered most later: the environment port, with nothing above it
permitted to mention a block ID.

**M1 — one persistent agent.** The vertical slice ran, and immediately exposed
bugs of the kind that make a simulation *look* like it works when it doesn't:

- agents forgot their goal every tick (the post-action write rebuilt the agent
  from a pre-action snapshot), so they re-decided constantly instead of
  pursuing anything;
- replanning regenerated an identical plan, so a failing goal looped forever —
  plans now differ by attempt, and goals are abandoned after a bounded number;
- a failed harvest corrected the *wrong* coordinates, so agents never learned a
  deposit was empty and walked back to it repeatedly;
- forests advertised only leaves and open ground only grass, so timber and
  stone were invisible and nothing could ever be built;
- the first shelter required coal for a torch, reachable only by deep mining —
  a first-night shelter was impossible;
- observation bounded by total quantity let abundant soil crowd out scarce
  food, so agents starved beside berry bushes.

**M2 — memory.** Retrieval scoring (recency × importance × relevance),
reflection, consolidation, decay. Proven by a test where a past failure at a
ridge outranks newer, louder memories when the same decision recurs — and where
the lesson survives consolidation after the episodes themselves fade.

**M3 — five agents.** Concurrent scheduler, region reservations with expiry,
messaging as events, relationships driven by event types. The recipient of a
tip gains a knowledge row sourced `told_by:<id>` — knowledge has provenance or
it isn't knowledge.

**M4/M5 — settlement, projects, division of labour.** Emergent coordination
answered with evidence (risk R6): no central work-board was needed. What it
*took* was two causal fixes: `claimedWork` must see active goals, not just
project claims, or "someone is already building" is always false and the
deposit half of the economy goes silent; and site selection must claim its
ground in the same transaction as the decision — one 400-round run spent 43 of
its last 50 failures on settlers re-siting onto ground another had just
claimed.

**M6 — the chronicle.** Generated strictly from the ledger, with a verifier
test that feeds it a fabricated sentence and watches the rejection. One tuning
lesson: a discovery is routine the second time — `resource_discovered` earns
high importance only the first time a resource kind is found, or a month of
coal finds crowds out the founding.

**M7 — observability.** Every CLI command reads a view model
(`civilizationView`, `agentView`, `failureView`, `costView`, …) and holds no
queries of its own. Wiring the CLI to real runs immediately exposed bugs the
views had hidden — which was the point.

**M8 — the First Settlement demo.** The acceptance suite, the demo scenario,
and the soak campaign — the next section.

## 4. The soak campaign

Thirty-day runs of `scenarios/first-settlement.yaml` (seed 3, fake environment,
rule-based provider, $0), each followed by failure-driven fixes. These are the
failures that mattered, in the order they fell.

### 4.1 Local steering wedged three settlers at one coordinate — 3,175 identical failures

A 400-round run ended with three settlers stuck at a single coordinate and
3,175 copies of the same failure in the ledger. The movement code steered
locally: consider forward candidates, take the best. Any concave obstacle — a
cove, a dead end — wedged it permanently, because every candidate it would
consider was forward into the wall.

The fix replaced steering with a bounded A* router over the height field
(`src/environment/traversal.ts`), shared by every environment. The regression
tests are the two halves of one claim: an agent gets out of a dead end, and it
still cannot walk through a cliff.

### 4.2 Wide siting surveys refused — 7 BAD_ARGS, all from one settler, all at attempt ≥ 2

Siting widens its search by 60 blocks per attempt. At a fixed survey resolution
of 2, a radius past ~120 asks for more cells than a survey may return
(16,384), so the late attempts of a long search failed BAD_ARGS without ever
looking at the ground. Resolution is now derived from the cell cap
(`√maxCells` per side), so a wide search samples coarsely instead of being
refused.

### 4.3 The probe fell between the samples — 23 TARGET_CHANGED on open ground

Coarsening exposed a quieter bug: the footprint probe looked up exact offsets
(0, half, full) in the sampled grid, and past resolution 2 those offsets mostly
land *between* samples. Every footprint probed fewer than four real heights, so
the search returned null however flat the terrain — 23 TARGET_CHANGED failures
on open ground in one run. The probe offsets now snap to the sampling grid.

Two stale tests were un-staled in the same pass, and both are process lessons.
The timber test asserted wood *held* at tick 260; the agent had long since
deposited it — the test now asserts wood *credited*. The replanning test's
premise ("a flat world has no trees") was false: the flat world's ground sits
in the tree band, so its "deterministic failure" was trajectory luck. It now
uses a `BarrenEnvironment` that overrides harvest to fail deterministically.
A test whose premise is wrong is worse than no test, because it teaches the
wrong mechanism.

### 4.4 Every structure on one footprint; the shelter rebuilt nightly

With wide surveys reliable, the next soak showed structures stacking: the plan
threaded only the *search anchor* (usually the settlement centre) through
reserve/clear/place/verify, so every structure went up on the same ground — a
later build's clear step demolished the standing shelter. And the shelter
goal never checked whether a shelter already existed, so settlers rebuilt one
every night.

The fix threads `at: 'build_site'` through every build step — each resolves
the ground the plan's own select_site claimed from the agent's knowledge — and
the shelter goal sends settlers home to sleep when a shelter is known, with a
fallback to the shared structures table for agents who never learned where it
is. The diag world after this fix shows three structures at three distinct
sites.

### 4.5 The shelter nobody could enter — 511 abandoned goals

The campaign's centre. A diag world (800 rounds) showed **511 seek_shelter
goals abandoned, zero completed** — every one ending PATH_BLOCKED at the wall
of a shelter that verified complete. It took four fixes, of which one was for
the wrong mechanism and one found the actual cause:

1. **Knowledge gap.** Only the builder knew where the shelter was; everyone
   else navigated to a stale or missing location. `knownShelterPosition` now
   falls back to the structures table. Real, insufficient.
2. **Stall ceiling.** Long journeys hit the 8-attempt continuation ceiling
   mid-stride and were declared stalled, so the ceiling was made
   progress-aware (≥8 blocks/tick resets the count). Measured effect on the
   abandonments: **zero**. Kept — it is right on its own merits — but recorded
   here as the campaign's cautionary tale: a plausible mechanism is not a
   cause, and only the rerun distinguishes them.
3. **The roofline target.** seek_shelter navigated to the structure's region
   centre, which is inside the roofline; the target became the floor centre.
   Real, insufficient.
4. **The moat.** The actual cause, in three stacked parts. The build origin
   sat one block above the surveyed ground, so the floor stacked *on* the
   dirt. Siting probed only the footprint's own columns, so a ledge edge read
   as flat. And — the decisive discovery, from reading the terrain around a
   stuck agent and finding a trench no terrain generator dug — the clear
   step's region expanded *downward* as well as outward, so every build site
   was first excavated into a **two-block moat**, and a hut behind a moat has
   a doorway the walker rightly refuses to climb. Entry now costs at most one
   honest step: the origin is the ground level itself, siting probes one ring
   beyond the footprint and refuses drops, and clearing never digs below the
   base layer.

The regression tests build the real blueprint and walk in through the door
across fallen-away ground — and were shown to fail against the old behaviour
(the stacked variant stops one block short of the door, exactly where the
soak's settlers stopped).

**Proof:** the rerun diag world went from 511 abandoned / 0 completed to
27 / 241. The final thirty-day soak: **917 completed, 26 abandoned — every
abandonment on days 0–1, before the shelter stood.** Zero for the last
twenty-eight days.

### 4.6 What the final soak still shows

Recorded in full in [results.md](results.md): foraging churns ~22
RESOURCE_UNAVAILABLE abandonments a day once the land around the settlement is
eaten out (the settlers are fed — 7,102 food in store — but the search widens
noisily instead of rotating known grounds); one settler can still wedge in a
terrain pocket for a day at a time; and the chronicle's importance bar leaves
steady work unrecorded after the founding. None of these hide: they are the
top of the failures table, and the first items of V1.

## 5. Process lessons

- **The failures table is the roadmap.** Every significant fix in M8 began as
  the top row of `worldloom failures`. The soak's success summary never once
  pointed at the next thing to fix.
- **Plausible is not caused.** The stall-ceiling fix was well-reasoned,
  well-tested, and had zero effect on the failure it targeted. Only rerunning
  the world separates "mechanism that could explain it" from "mechanism that
  did".
- **Read the world before fixing the code.** The moat was found by probing the
  terrain column-by-column around a stuck agent and noticing a trench the
  generator never digs — a man-made hole. The three preceding fixes were all
  defensible readings of the same symptoms.
- **Test premises rot.** Two tests failed not because the code changed but
  because their assumptions about the world were never true. Both are now
  deterministic about the thing they actually test.
- **Conventions need comments, not corrections.** One "fix" changed a correct
  height convention (`fromY` is feet level) because it was undocumented; it was
  reverted and the convention written down instead. The bug was in the
  documentation, not the code.
- **Mind exit codes through pipes.** A typecheck piped through `tail` lost its
  exit status and let a broken commit land. Small, human, and worth more than
  most linter rules.

## 6. Where this leaves V1

V0's exit criteria are all met with artifacts (see
[results.md](results.md)). The handoff list, in priority order:

1. **The live-server soak.** The Minecraft adapter is unit-tested against a
   mock bridge and was smoke-tested against a live Paper server early on
   (`5595623`), but no month-long run has executed against one. That run is
   V1's first item; risks R2 (silent fills) and R3 (bridge kicks) are paper
   mitigations until it happens.
2. **Foraging economics.** Rotate known grounds; remember exhaustion; stop
   re-answering "where did the berries go" 22 times a day.
3. **Terrain-pocket recovery.** The router escapes dead ends; the replanner
   abandons and retries; one settler still lost a day to a pocket. A
   wedge-memory ("I cannot reach it from *here* — approach from there") is the
   natural fix and the memory system already supports it.
4. **Chronicle richness.** The importance bar keeps the chronicle truthful and
   thin. Tuning it so a month of labour reads as more than a footnote is a
   rendering problem, not a grounding one.
