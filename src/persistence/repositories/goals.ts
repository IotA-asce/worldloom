/**
 * Goal and plan persistence.
 *
 * Both live here because they are always read together: an agent's tick needs
 * its active goal and that goal's current plan in the same breath.
 */

import type { AgentId, GoalId, PlanId } from '../../core/ids.ts';
import type { Goal, GoalKind, GoalParams, GoalState } from '../../goals/goal.ts';
import type { Plan, PlanState, PlanStep } from '../../goals/plan.ts';
import {
  jsonCol,
  nullableNumberCol,
  nullableTextCol,
  numberCol,
  requireRow,
  textCol,
  toJson,
  type Database,
  type Row,
} from '../db.ts';

function toGoal(row: Row): Goal {
  return {
    id: textCol(row, 'id') as GoalId,
    agentId: textCol(row, 'agent_id') as AgentId,
    kind: textCol(row, 'kind') as GoalKind,
    params: jsonCol<GoalParams[GoalKind]>(row, 'params'),
    state: textCol(row, 'state') as GoalState,
    priority: numberCol(row, 'priority'),
    reason: textCol(row, 'reason'),
    parentGoalId: nullableTextCol(row, 'parent_goal_id') as GoalId | null,
    createdAtDay: numberCol(row, 'created_at_day'),
    createdAtTicks: numberCol(row, 'created_at_ticks'),
    resolvedAtTicks: nullableNumberCol(row, 'resolved_at_ticks'),
    outcome: nullableTextCol(row, 'outcome'),
  };
}

function toPlan(row: Row): Plan {
  return {
    id: textCol(row, 'id') as PlanId,
    goalId: textCol(row, 'goal_id') as GoalId,
    agentId: textCol(row, 'agent_id') as AgentId,
    steps: jsonCol<PlanStep[]>(row, 'steps'),
    currentStep: numberCol(row, 'current_step'),
    state: textCol(row, 'state') as PlanState,
    createdAtTicks: numberCol(row, 'created_at_ticks'),
    revision: numberCol(row, 'revision'),
  };
}

export class GoalRepository {
  constructor(private readonly db: Database) {}

  insert(goal: Goal): void {
    this.db
      .prepare(
        `INSERT INTO goals (id, agent_id, kind, params, state, priority, reason,
                            parent_goal_id, created_at_day, created_at_ticks,
                            resolved_at_ticks, outcome)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        goal.id,
        goal.agentId,
        goal.kind,
        toJson(goal.params),
        goal.state,
        goal.priority,
        goal.reason,
        goal.parentGoalId,
        goal.createdAtDay,
        goal.createdAtTicks,
        goal.resolvedAtTicks,
        goal.outcome,
      );
  }

  update(goal: Goal): void {
    const result = this.db
      .prepare(
        `UPDATE goals
            SET kind = ?, params = ?, state = ?, priority = ?, reason = ?,
                parent_goal_id = ?, resolved_at_ticks = ?, outcome = ?
          WHERE id = ?`,
      )
      .run(
        goal.kind,
        toJson(goal.params),
        goal.state,
        goal.priority,
        goal.reason,
        goal.parentGoalId,
        goal.resolvedAtTicks,
        goal.outcome,
        goal.id,
      );
    if (Number(result.changes) === 0) {
      throw new Error(`cannot update unknown goal ${goal.id}`);
    }
  }

  find(id: GoalId): Goal | null {
    const row = this.db.prepare('SELECT * FROM goals WHERE id = ?').get(id);
    return row === undefined ? null : toGoal(row);
  }

  get(id: GoalId): Goal {
    return toGoal(requireRow(this.db.prepare('SELECT * FROM goals WHERE id = ?').get(id), `goal ${id}`));
  }

  /** The agent's pursuable goals, highest priority first. */
  activeFor(agentId: AgentId): Goal[] {
    return this.db
      .prepare(
        `SELECT * FROM goals
          WHERE agent_id = ? AND state IN ('proposed', 'active')
          ORDER BY priority DESC, created_at_ticks ASC`,
      )
      .all(agentId)
      .map(toGoal);
  }

  blockedFor(agentId: AgentId): Goal[] {
    return this.db
      .prepare("SELECT * FROM goals WHERE agent_id = ? AND state = 'blocked' ORDER BY priority DESC")
      .all(agentId)
      .map(toGoal);
  }

  allFor(agentId: AgentId, limit = 50): Goal[] {
    return this.db
      .prepare('SELECT * FROM goals WHERE agent_id = ? ORDER BY created_at_ticks DESC LIMIT ?')
      .all(agentId, limit)
      .map(toGoal);
  }

  /** Goals of a kind that are still in play, across all agents. Used by
   *  coordination to see what work is already claimed (requirement 18). */
  activeByKind(kind: GoalKind): Goal[] {
    return this.db
      .prepare(
        `SELECT * FROM goals
          WHERE kind = ? AND state IN ('proposed', 'active')
          ORDER BY created_at_ticks ASC`,
      )
      .all(kind)
      .map(toGoal);
  }

  /** All in-play goals, for the division-of-labour check and the dashboard. */
  allActive(): Goal[] {
    return this.db
      .prepare("SELECT * FROM goals WHERE state IN ('proposed', 'active') ORDER BY agent_id")
      .all()
      .map(toGoal);
  }

  childrenOf(goalId: GoalId): Goal[] {
    return this.db
      .prepare('SELECT * FROM goals WHERE parent_goal_id = ? ORDER BY created_at_ticks ASC')
      .all(goalId)
      .map(toGoal);
  }
}

export class PlanRepository {
  constructor(private readonly db: Database) {}

  insert(plan: Plan): void {
    this.db
      .prepare(
        `INSERT INTO plans (id, goal_id, agent_id, steps, current_step, state,
                            created_at_ticks, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        plan.id,
        plan.goalId,
        plan.agentId,
        toJson(plan.steps),
        plan.currentStep,
        plan.state,
        plan.createdAtTicks,
        plan.revision,
      );
  }

  update(plan: Plan): void {
    const result = this.db
      .prepare(
        `UPDATE plans SET steps = ?, current_step = ?, state = ?, revision = ? WHERE id = ?`,
      )
      .run(toJson(plan.steps), plan.currentStep, plan.state, plan.revision, plan.id);
    if (Number(result.changes) === 0) {
      throw new Error(`cannot update unknown plan ${plan.id}`);
    }
  }

  find(id: PlanId): Plan | null {
    const row = this.db.prepare('SELECT * FROM plans WHERE id = ?').get(id);
    return row === undefined ? null : toPlan(row);
  }

  /** The live plan for a goal. Superseded plans are kept for the audit trail. */
  activeForGoal(goalId: GoalId): Plan | null {
    const row = this.db
      .prepare(
        `SELECT * FROM plans WHERE goal_id = ? AND state = 'active'
          ORDER BY revision DESC, created_at_ticks DESC LIMIT 1`,
      )
      .get(goalId);
    return row === undefined ? null : toPlan(row);
  }

  activeForAgent(agentId: AgentId): Plan | null {
    const row = this.db
      .prepare(
        `SELECT * FROM plans WHERE agent_id = ? AND state = 'active'
          ORDER BY created_at_ticks DESC LIMIT 1`,
      )
      .get(agentId);
    return row === undefined ? null : toPlan(row);
  }

  historyForGoal(goalId: GoalId): Plan[] {
    return this.db
      .prepare('SELECT * FROM plans WHERE goal_id = ? ORDER BY revision ASC')
      .all(goalId)
      .map(toPlan);
  }

  /** Mark every live plan for a goal superseded, before a replan inserts a new one. */
  supersedeForGoal(goalId: GoalId): void {
    this.db
      .prepare("UPDATE plans SET state = 'superseded' WHERE goal_id = ? AND state = 'active'")
      .run(goalId);
  }
}
