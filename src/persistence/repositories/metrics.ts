/**
 * The audit trail and cost instrumentation.
 *
 * `decisions` is what makes "why did Mira abandon the farm project?" a query
 * rather than an archaeology exercise (ADR-0008): the observation she acted on,
 * the memories she retrieved, the prompt, the response, and the action chosen.
 *
 * `llm_calls` makes token spend attributable per agent, per category and per day
 * (requirement 29).
 */

import type { AgentId, DecisionId, EventId, LlmCallId, MemoryId } from '../../core/ids.ts';
import { type IdFactory } from '../../core/ids.ts';
import type { ReasoningCategory } from '../../core/config.ts';
import {
  boolCol,
  jsonCol,
  nullableTextCol,
  numberCol,
  textCol,
  toJson,
  toSqlBool,
  type Database,
  type Row,
} from '../db.ts';

export interface DecisionRecord {
  readonly id: DecisionId;
  readonly agentId: AgentId;
  readonly category: ReasoningCategory;
  readonly worldTicks: number;
  readonly day: number;
  /** The normalised observation the agent acted on. */
  readonly observation: unknown;
  readonly memoryIds: readonly MemoryId[];
  readonly prompt: string | null;
  readonly response: string | null;
  readonly model: string;
  readonly chosenAction: string;
  readonly eventId: EventId | null;
  readonly llmCallId: LlmCallId | null;
}

export type NewDecision = Omit<DecisionRecord, 'id'>;

export interface LlmCallRecord {
  readonly id: LlmCallId;
  readonly agentId: AgentId | null;
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

export type NewLlmCall = Omit<LlmCallRecord, 'id'>;

export interface CostSummary {
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly failures: number;
}

const EMPTY_SUMMARY: CostSummary = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  failures: 0,
};

export class DecisionRepository {
  constructor(
    private readonly db: Database,
    private readonly ids: IdFactory,
    /** When false, prompts and responses are dropped but the row is still
     *  written — the causal link survives even with recording disabled. */
    private readonly recordText = true,
  ) {}

  record(decision: NewDecision): DecisionRecord {
    const id = this.ids.next('dec');
    const stored: DecisionRecord = {
      ...decision,
      id,
      prompt: this.recordText ? decision.prompt : null,
      response: this.recordText ? decision.response : null,
    };

    this.db
      .prepare(
        `INSERT INTO decisions (id, agent_id, category, world_ticks, day, observation,
                                memory_ids, prompt, response, model, chosen_action,
                                event_id, llm_call_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        stored.id,
        stored.agentId,
        stored.category,
        stored.worldTicks,
        stored.day,
        toJson(stored.observation),
        toJson(stored.memoryIds),
        stored.prompt,
        stored.response,
        stored.model,
        stored.chosenAction,
        stored.eventId,
        stored.llmCallId,
      );

    return stored;
  }

  find(id: DecisionId): DecisionRecord | null {
    const row = this.db.prepare('SELECT * FROM decisions WHERE id = ?').get(id);
    return row === undefined ? null : toDecision(row);
  }

  /** An agent's decision history, newest first — the `worldloom why` query. */
  forAgent(agentId: AgentId, limit = 20): DecisionRecord[] {
    return this.db
      .prepare('SELECT * FROM decisions WHERE agent_id = ? ORDER BY world_ticks DESC LIMIT ?')
      .all(agentId, Math.max(1, Math.floor(limit)))
      .map(toDecision);
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM decisions').get();
    return row === undefined ? 0 : numberCol(row, 'n');
  }
}

export class LlmCallRepository {
  constructor(
    private readonly db: Database,
    private readonly ids: IdFactory,
  ) {}

  record(call: NewLlmCall): LlmCallRecord {
    const id = this.ids.next('llm');
    this.db
      .prepare(
        `INSERT INTO llm_calls (id, agent_id, category, provider, model, input_tokens,
                                output_tokens, cost_usd, duration_ms, day, ok, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        call.agentId,
        call.category,
        call.provider,
        call.model,
        call.inputTokens,
        call.outputTokens,
        call.costUsd,
        call.durationMs,
        call.day,
        toSqlBool(call.ok),
        call.error,
        call.createdAt,
      );
    return { ...call, id };
  }

  /** Whole-run totals. Checked against the configured budget each tick. */
  total(): CostSummary {
    return this.summarise('SELECT', '');
  }

  byCategory(): Map<ReasoningCategory, CostSummary> {
    return this.grouped('category') as Map<ReasoningCategory, CostSummary>;
  }

  byAgent(): Map<string, CostSummary> {
    return this.grouped('agent_id');
  }

  byDay(): Map<string, CostSummary> {
    return this.grouped('day');
  }

  recent(limit = 20): LlmCallRecord[] {
    return this.db
      .prepare('SELECT * FROM llm_calls ORDER BY created_at DESC LIMIT ?')
      .all(Math.max(1, Math.floor(limit)))
      .map(toLlmCall);
  }

  private summarise(_verb: string, where: string, params: readonly (string | number)[] = []): CostSummary {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS calls,
                COALESCE(SUM(input_tokens), 0)  AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(cost_usd), 0)      AS cost_usd,
                COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS failures
           FROM llm_calls ${where}`,
      )
      .get(...params);
    if (row === undefined) return EMPTY_SUMMARY;
    return {
      calls: numberCol(row, 'calls'),
      inputTokens: numberCol(row, 'input_tokens'),
      outputTokens: numberCol(row, 'output_tokens'),
      costUsd: numberCol(row, 'cost_usd'),
      failures: numberCol(row, 'failures'),
    };
  }

  /** `column` is never user input — only the three literals above. */
  private grouped(column: 'category' | 'agent_id' | 'day'): Map<string, CostSummary> {
    const rows = this.db
      .prepare(
        `SELECT ${column} AS key,
                COUNT(*) AS calls,
                COALESCE(SUM(input_tokens), 0)  AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(cost_usd), 0)      AS cost_usd,
                COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS failures
           FROM llm_calls GROUP BY ${column} ORDER BY cost_usd DESC`,
      )
      .all();

    const out = new Map<string, CostSummary>();
    for (const row of rows) {
      const key = row.key === null ? '(none)' : String(row.key);
      out.set(key, {
        calls: numberCol(row, 'calls'),
        inputTokens: numberCol(row, 'input_tokens'),
        outputTokens: numberCol(row, 'output_tokens'),
        costUsd: numberCol(row, 'cost_usd'),
        failures: numberCol(row, 'failures'),
      });
    }
    return out;
  }
}

function toDecision(row: Row): DecisionRecord {
  return {
    id: textCol(row, 'id') as DecisionId,
    agentId: textCol(row, 'agent_id') as AgentId,
    category: textCol(row, 'category') as ReasoningCategory,
    worldTicks: numberCol(row, 'world_ticks'),
    day: numberCol(row, 'day'),
    observation: jsonCol<unknown>(row, 'observation'),
    memoryIds: jsonCol<MemoryId[]>(row, 'memory_ids'),
    prompt: nullableTextCol(row, 'prompt'),
    response: nullableTextCol(row, 'response'),
    model: textCol(row, 'model'),
    chosenAction: textCol(row, 'chosen_action'),
    eventId: nullableTextCol(row, 'event_id') as EventId | null,
    llmCallId: nullableTextCol(row, 'llm_call_id') as LlmCallId | null,
  };
}

function toLlmCall(row: Row): LlmCallRecord {
  return {
    id: textCol(row, 'id') as LlmCallId,
    agentId: nullableTextCol(row, 'agent_id') as AgentId | null,
    category: textCol(row, 'category') as ReasoningCategory,
    provider: textCol(row, 'provider'),
    model: textCol(row, 'model'),
    inputTokens: numberCol(row, 'input_tokens'),
    outputTokens: numberCol(row, 'output_tokens'),
    costUsd: numberCol(row, 'cost_usd'),
    durationMs: numberCol(row, 'duration_ms'),
    day: numberCol(row, 'day'),
    ok: boolCol(row, 'ok'),
    error: nullableTextCol(row, 'error'),
    createdAt: numberCol(row, 'created_at'),
  };
}
