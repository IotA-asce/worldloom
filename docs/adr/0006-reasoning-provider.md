# ADR-0006 — Provider abstraction with a no-LLM heuristic implementation

**Status:** accepted · **Date:** 2026-08-07

## Context

Worldloom must not be welded to one vendor (requirement 26), must demand
structured output (27), must be token-frugal (29), and must be testable without
paid API calls (40).

## Decision

```ts
interface ReasoningProvider {
  readonly id: string
  generate(req: GenerateRequest): Promise<GenerateResult>
  generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>
}
```

Requests carry a `category` (`goal_selection`, `replanning`, …), which drives
both per-category model routing and cost attribution. `generateStructured`
takes a schema, validates the response against it, and retries a bounded number
of times with the validation error fed back before giving up.

Four implementations:

| Implementation | Purpose |
|---|---|
| `AnthropicProvider` | production reasoning via the API's structured-output support |
| `HeuristicProvider` | **rule-based, no network** — every category answered deterministically |
| `ScriptedProvider` | fixture playback keyed by category + prompt hash, for tests |
| `RecordingProvider` | wraps another, writes fixtures for `ScriptedProvider` |

Structured output uses `output_config.format` with the category's schema (via the
SDK's `messages.parse`), so validation happens in the API rather than in a
prompt instruction plus a hopeful `JSON.parse`. Asking for JSON in prose and
parsing the reply is the standard source of silent simulation corruption, and it
is what requirement 27 forbids.

**Every failure degrades to the rule, and none throws.** A refusal, a response
truncated at `max_tokens`, output that fails validation, a rate limit, a dead
network, or an exhausted budget all produce a successful result whose `source` is
`fallback`, carrying the reason. A model outage makes the civilization duller; it
does not stop the world. Because the reason is recorded, a run's actual reliance
on the model is measurable rather than assumed.

The mechanism that makes this work is a single required field:
`ReasoningRequest.fallback`. Every call site must supply a deterministic answer,
which is why `HeuristicProvider`'s entire implementation is "call it".

## The heuristic provider is load-bearing

It is not a stub. It makes `npm test` exercise the real simulation end to end,
gives contributors a keyless path, and provides the fallback above. Requiring it
to answer every category also disciplines prompt design: if a decision can't be
expressed as a schema a rule engine could fill, the schema is too vague.

## Alternatives rejected

- **Call the Anthropic SDK directly** — fastest to write, and it would put
  vendor types into agent code, which requirement 26 forbids.
- **A general LLM framework (LangChain et al.)** — a large dependency to obtain
  an interface with two methods.
- **Prose parsing instead of schemas** — requirement 27 forbids it, and it is
  the standard source of silent simulation corruption.

## Consequences

- Model routing per category is configuration, so "strong model for strategy,
  cheap model for summarisation" needs no code change.
- Every call passes one instrumentation point, so token and cost metrics are
  complete by construction rather than by remembering to log.
- Cost: each reasoning category needs a schema *and* a heuristic. That is real
  work, and it is the work that keeps the simulation honest and cheap.
