/**
 * Cost, token and reliance accounting.
 *
 * Requirement 29 asks for LLM calls, input and output tokens, estimated cost,
 * and attribution per agent, per simulated day and per reasoning category. Those
 * are all aggregates over `llm_calls`, which the provider meters on every
 * attempt — so this module is arithmetic over rows rather than instrumentation.
 *
 * Two additions earn their place beyond the literal requirement:
 *
 *  - **Efficiency, per agent-day.** Totals answer "what has this cost so far",
 *    which is the wrong question when deciding whether to start a thirty-day run
 *    with eight settlers. Tokens per agent-day is the figure that extrapolates,
 *    and it is the one to watch: it should be roughly flat, and a run where it
 *    climbs is one whose prompts are growing with history.
 *  - **Reliance.** A run can look healthy while every model call quietly falls
 *    back to a rule — agents that still act, just duller. `ReasoningReliance`
 *    makes that visible instead of surprising, because it is exactly the failure
 *    mode a passing test suite cannot catch.
 *
 * On attribution, honestly: the usage callback that meters the provider is not
 * told which agent it is answering for, so `llm_calls.agent_id` is normally
 * null. Rather than apportioning spend by some plausible-looking share, the
 * measured attribution is reported as it stands (usually one unattributed
 * bucket) alongside per-agent *decision* counts, which are recorded per agent
 * and are real. `unattributedCalls` says how much of the spend that covers.
 */

import type { ReasoningCategory } from '../core/config.ts';
import type { AgentId } from '../core/ids.ts';
import type { CostSummary, LlmCallRecord } from '../persistence/repositories/metrics.ts';
import type { Store } from '../persistence/store.ts';
import { isKnownModel } from '../reasoning/pricing.ts';
import { agentNameIndex, type ActorView } from './views.ts';

/**
 * Model names that mean "no model was involved". They come from the providers
 * themselves (`HeuristicProvider.model = 'heuristic'`,
 * `ScriptedProvider.model = 'scripted'`), so a decision row carries its own
 * evidence of having been answered by a rule.
 */
export const RULE_ENGINE_MODELS: ReadonlySet<string> = new Set(['heuristic', 'scripted', 'none']);

/** Where a recorded decision's answer came from. */
export type DecisionAnswerSource =
  /** A rule answered; no model was asked. */
  | 'rule_based'
  /** The model answered and its output validated. */
  | 'model'
  /** The model was asked and the rule answered instead — a degraded decision. */
  | 'model_fallback'
  /** This world does not store decision text, so the two cannot be told apart. */
  | 'unknown';

/**
 * Classify one decision.
 *
 * A decision row records the model but not the `AnswerSource` the reasoning
 * result carried, so the classification is reconstructed: a rule-engine model
 * name means no model was asked, a stored response means the model answered, and
 * the absence of a response in a world that *does* store text means the model
 * was asked and fell back.
 */
export function answerSourceOf(
  decision: { readonly model: string; readonly response: string | null },
  textRecorded: boolean,
): DecisionAnswerSource {
  if (RULE_ENGINE_MODELS.has(decision.model)) return 'rule_based';
  if (decision.response !== null) return 'model';
  return textRecorded ? 'model_fallback' : 'unknown';
}

export interface TokenTotals {
  readonly calls: number;
  readonly failedCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number;
}

export interface CategoryCostView extends TokenTotals {
  readonly category: ReasoningCategory;
}

export interface DayCostView extends TokenTotals {
  readonly day: number;
  /** Tokens divided by the settlers alive to spend them. */
  readonly tokensPerAgent: number;
  readonly decisions: number;
}

export interface ModelCostView extends TokenTotals {
  readonly model: string;
  /** False for a model Worldloom has no published rate for; its tokens are
   *  counted, its cost is reported as zero (see `reasoning/pricing.ts`). */
  readonly priced: boolean;
}

export interface AgentCostView extends TokenTotals {
  /** Null for the unattributed bucket. */
  readonly agent: ActorView | null;
}

export interface AgentActivityView {
  readonly agent: ActorView;
  readonly decisions: number;
  readonly decisionsPerDay: number;
}

/**
 * Cost per unit of simulated life, which is what makes a long run's bill
 * predictable. `agentDays` is the denominator that matters: doubling the
 * settlers or doubling the days should roughly double the spend, and these
 * ratios staying flat is the evidence that it does.
 */
export interface EfficiencyView {
  readonly days: number;
  readonly agents: number;
  readonly agentDays: number;
  readonly calls: number;
  readonly totalTokens: number;
  readonly costUsd: number;
  readonly decisions: number;
  readonly tokensPerAgentDay: number;
  readonly costUsdPerAgentDay: number;
  readonly callsPerAgentDay: number;
  readonly decisionsPerAgentDay: number;
  readonly tokensPerCall: number;
  readonly costUsdPerCall: number;
  /** What another simulated day would cost at the run's current rate. */
  readonly projectedCostUsdPerDay: number;
}

export interface RelianceView {
  readonly decisions: number;
  readonly modelAnswered: number;
  readonly ruleAnswered: number;
  /** The model was asked and could not be used. Every one of these is an agent
   *  that thought with a rule when it was meant to think with a model. */
  readonly modelFallback: number;
  readonly undetermined: number;
  /** 0..1. A run at 1.0 is running entirely on rules — correct with the
   *  heuristic provider, a problem with a configured model. */
  readonly ruleAnsweredShare: number;
  readonly failedCalls: number;
  readonly byCategory: readonly {
    readonly category: ReasoningCategory;
    readonly decisions: number;
    readonly modelAnswered: number;
    readonly ruleAnswered: number;
    readonly modelFallback: number;
    readonly undetermined: number;
  }[];
  readonly byModel: readonly {
    readonly model: string;
    readonly decisions: number;
    readonly ruleEngine: boolean;
  }[];
  /** False when this world stores no decision text, which is what makes
   *  `undetermined` non-zero. */
  readonly textRecorded: boolean;
}

export interface LlmCallView {
  readonly id: string;
  readonly agent: ActorView | null;
  readonly category: ReasoningCategory;
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly durationMs: number;
  readonly day: number;
  readonly ok: boolean;
  readonly error: string | null;
  readonly createdAt: number;
}

export interface CostView {
  readonly total: TokenTotals;
  readonly byCategory: readonly CategoryCostView[];
  readonly byDay: readonly DayCostView[];
  readonly byModel: readonly ModelCostView[];
  readonly byAgent: readonly AgentCostView[];
  /** Decisions per agent — attribution that is recorded rather than inferred. */
  readonly perAgentActivity: readonly AgentActivityView[];
  /** Calls whose agent is unknown, because the provider's usage callback does
   *  not carry one. Read `byAgent` in the light of this number. */
  readonly unattributedCalls: number;
  readonly efficiency: EfficiencyView;
  readonly reliance: RelianceView;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function totalsOf(summary: CostSummary): TokenTotals {
  return {
    calls: summary.calls,
    failedCalls: summary.failures,
    inputTokens: summary.inputTokens,
    outputTokens: summary.outputTokens,
    totalTokens: summary.inputTokens + summary.outputTokens,
    costUsd: summary.costUsd,
  };
}

/** Divide without producing Infinity or NaN — a view is read, not computed on. */
function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

/**
 * Simulated days the run covers.
 *
 * Day 0 counts as one day: a run that has not seen midnight yet has still
 * happened, and dividing by zero would make every efficiency figure useless on
 * exactly the runs people look at first.
 */
export function daysElapsed(store: Store): number {
  const clockDay = store.simulation.exists() ? store.simulation.currentTime().day : 0;
  return Math.max(clockDay, store.events.latestDay()) + 1;
}

// ── Views ───────────────────────────────────────────────────────────────────

export function efficiencyView(store: Store): EfficiencyView {
  const total = totalsOf(store.llmCalls.total());
  const days = daysElapsed(store);
  const agents = store.agents.count();
  const agentDays = Math.max(1, agents * days);
  const decisions = store.decisions.count();

  return {
    days,
    agents,
    agentDays,
    calls: total.calls,
    totalTokens: total.totalTokens,
    costUsd: total.costUsd,
    decisions,
    tokensPerAgentDay: ratio(total.totalTokens, agentDays),
    costUsdPerAgentDay: ratio(total.costUsd, agentDays),
    callsPerAgentDay: ratio(total.calls, agentDays),
    decisionsPerAgentDay: ratio(decisions, agentDays),
    tokensPerCall: ratio(total.totalTokens, total.calls),
    costUsdPerCall: ratio(total.costUsd, total.calls),
    projectedCostUsdPerDay: ratio(total.costUsd, days),
  };
}

export function relianceView(store: Store): RelianceView {
  const textRecorded = store.decisions.textRecorded();
  const rows = store.decisions.countsByCategoryAndModel();

  const perCategory = new Map<
    ReasoningCategory,
    { decisions: number; modelAnswered: number; ruleAnswered: number; modelFallback: number; undetermined: number }
  >();
  const perModel = new Map<string, number>();

  let decisions = 0;
  let modelAnswered = 0;
  let ruleAnswered = 0;
  let modelFallback = 0;
  let undetermined = 0;

  for (const row of rows) {
    const bucket =
      perCategory.get(row.category) ??
      { decisions: 0, modelAnswered: 0, ruleAnswered: 0, modelFallback: 0, undetermined: 0 };

    const ruleEngine = RULE_ENGINE_MODELS.has(row.model);
    const answered = ruleEngine ? 0 : row.withResponse;
    const remainder = row.decisions - answered;
    const rules = ruleEngine ? row.decisions : 0;
    const degraded = ruleEngine ? 0 : textRecorded ? remainder : 0;
    const unclear = ruleEngine ? 0 : textRecorded ? 0 : remainder;

    bucket.decisions += row.decisions;
    bucket.modelAnswered += answered;
    bucket.ruleAnswered += rules;
    bucket.modelFallback += degraded;
    bucket.undetermined += unclear;
    perCategory.set(row.category, bucket);

    perModel.set(row.model, (perModel.get(row.model) ?? 0) + row.decisions);

    decisions += row.decisions;
    modelAnswered += answered;
    ruleAnswered += rules;
    modelFallback += degraded;
    undetermined += unclear;
  }

  return {
    decisions,
    modelAnswered,
    ruleAnswered,
    modelFallback,
    undetermined,
    ruleAnsweredShare: ratio(ruleAnswered + modelFallback, decisions),
    failedCalls: store.llmCalls.total().failures,
    byCategory: [...perCategory.entries()]
      .sort((a, b) => b[1].decisions - a[1].decisions || a[0].localeCompare(b[0]))
      .map(([category, bucket]) => ({ category, ...bucket })),
    byModel: [...perModel.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([model, count]) => ({
        model,
        decisions: count,
        ruleEngine: RULE_ENGINE_MODELS.has(model),
      })),
    textRecorded,
  };
}

/** Recent model calls, newest first — including the ones that failed. */
export function recentCallsView(store: Store, limit = 20): readonly LlmCallView[] {
  const names = agentNameIndex(store);
  return store.llmCalls.recent(limit).map((call) => llmCallView(call, names));
}

/** Only the failures. Each is a decision that had to fall back to a rule. */
export function failedCallsView(store: Store, limit = 20): readonly LlmCallView[] {
  const names = agentNameIndex(store);
  return store.llmCalls.recentFailures(limit).map((call) => llmCallView(call, names));
}

function llmCallView(call: LlmCallRecord, names: ReadonlyMap<string, string>): LlmCallView {
  return {
    id: call.id,
    agent:
      call.agentId === null ? null : { id: call.agentId, name: names.get(call.agentId) ?? null },
    category: call.category,
    provider: call.provider,
    model: call.model,
    inputTokens: call.inputTokens,
    outputTokens: call.outputTokens,
    costUsd: call.costUsd,
    durationMs: call.durationMs,
    day: call.day,
    ok: call.ok,
    error: call.error,
    createdAt: call.createdAt,
  };
}

/**
 * The answer to "what did this run cost", in one object.
 *
 * A run that never called a model produces a fully-zeroed view rather than an
 * empty one, so a caller can render it without special-casing the common
 * rule-based case.
 */
export function costView(store: Store): CostView {
  const names = agentNameIndex(store);
  const agents = store.agents.all();
  const decisionsByAgent = store.decisions.countsByAgent();
  const decisionsByDay = store.decisions.countsByDay();
  const days = daysElapsed(store);
  const livingAgents = Math.max(1, store.agents.living().length);

  const byCategory: CategoryCostView[] = [...store.llmCalls.byCategory().entries()]
    .map(([category, summary]) => ({ category, ...totalsOf(summary) }))
    .sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls);

  const byDay: DayCostView[] = [...store.llmCalls.byDay().entries()]
    .map(([key, summary]) => {
      const day = Number(key);
      const totals = totalsOf(summary);
      return {
        day: Number.isFinite(day) ? day : 0,
        ...totals,
        tokensPerAgent: ratio(totals.totalTokens, livingAgents),
        decisions: decisionsByDay.get(day) ?? 0,
      };
    })
    .sort((a, b) => a.day - b.day);

  const byModel: ModelCostView[] = [...store.llmCalls.byModel().entries()]
    .map(([model, summary]) => ({ model, priced: isKnownModel(model), ...totalsOf(summary) }))
    .sort((a, b) => b.costUsd - a.costUsd || a.model.localeCompare(b.model));

  const byAgent: AgentCostView[] = [...store.llmCalls.byAgent().entries()]
    .map(([key, summary]) => ({
      // `grouped` renders a null agent_id as '(none)'.
      agent: key === '(none)' ? null : { id: key, name: names.get(key) ?? null },
      ...totalsOf(summary),
    }))
    .sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls);

  const perAgentActivity: AgentActivityView[] = agents
    .map((agent) => {
      const decisions = decisionsByAgent.get(agent.id as AgentId) ?? 0;
      return {
        agent: { id: agent.id as string, name: agent.name },
        decisions,
        decisionsPerDay: ratio(decisions, days),
      };
    })
    .sort((a, b) => b.decisions - a.decisions || a.agent.id.localeCompare(b.agent.id));

  return {
    total: totalsOf(store.llmCalls.total()),
    byCategory,
    byDay,
    byModel,
    byAgent,
    perAgentActivity,
    unattributedCalls: store.llmCalls.unattributedCalls(),
    efficiency: efficiencyView(store),
    reliance: relianceView(store),
  };
}
