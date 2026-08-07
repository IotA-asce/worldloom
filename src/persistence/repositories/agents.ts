/**
 * Agent persistence. Every field of an agent's identity and current activity
 * round-trips, which is what makes a mid-plan restart possible (ADR-0001).
 */

import type {
  Agent,
  AgentStatus,
  Needs,
  Personality,
  Skills,
  TickPhase,
} from '../../agents/agent.ts';
import type { AgentId, GoalId } from '../../core/ids.ts';
import {
  jsonCol,
  nullableTextCol,
  numberCol,
  requireRow,
  textCol,
  toJson,
  type Database,
  type Row,
} from '../db.ts';

function toAgent(row: Row): Agent {
  return {
    id: textCol(row, 'id') as AgentId,
    name: textCol(row, 'name'),
    role: textCol(row, 'role'),
    personality: jsonCol<Personality>(row, 'personality'),
    skills: jsonCol<Skills>(row, 'skills'),
    needs: jsonCol<Needs>(row, 'needs'),
    position: { x: numberCol(row, 'x'), y: numberCol(row, 'y'), z: numberCol(row, 'z') },
    health: numberCol(row, 'health'),
    status: textCol(row, 'status') as AgentStatus,
    phase: textCol(row, 'phase') as TickPhase,
    currentGoalId: nullableTextCol(row, 'current_goal_id') as GoalId | null,
    lastTickAt: numberCol(row, 'last_tick_at'),
    activity: textCol(row, 'activity'),
    spawnedAtDay: numberCol(row, 'spawned_at_day'),
  };
}

export class AgentRepository {
  constructor(private readonly db: Database) {}

  insert(agent: Agent): void {
    this.db
      .prepare(
        `INSERT INTO agents (id, name, role, personality, skills, needs, x, y, z,
                             health, status, phase, current_goal_id, last_tick_at,
                             activity, spawned_at_day)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        agent.id,
        agent.name,
        agent.role,
        toJson(agent.personality),
        toJson(agent.skills),
        toJson(agent.needs),
        agent.position.x,
        agent.position.y,
        agent.position.z,
        agent.health,
        agent.status,
        agent.phase,
        agent.currentGoalId,
        agent.lastTickAt,
        agent.activity,
        agent.spawnedAtDay,
      );
  }

  /** Full-row update. Agents are small; a partial-update API isn't worth the
   *  risk of forgetting a field on restore. */
  update(agent: Agent): void {
    const result = this.db
      .prepare(
        `UPDATE agents
            SET name = ?, role = ?, personality = ?, skills = ?, needs = ?,
                x = ?, y = ?, z = ?, health = ?, status = ?, phase = ?,
                current_goal_id = ?, last_tick_at = ?, activity = ?, spawned_at_day = ?
          WHERE id = ?`,
      )
      .run(
        agent.name,
        agent.role,
        toJson(agent.personality),
        toJson(agent.skills),
        toJson(agent.needs),
        agent.position.x,
        agent.position.y,
        agent.position.z,
        agent.health,
        agent.status,
        agent.phase,
        agent.currentGoalId,
        agent.lastTickAt,
        agent.activity,
        agent.spawnedAtDay,
        agent.id,
      );
    if (Number(result.changes) === 0) {
      throw new Error(`cannot update unknown agent ${agent.id}`);
    }
  }

  find(id: AgentId): Agent | null {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
    return row === undefined ? null : toAgent(row);
  }

  get(id: AgentId): Agent {
    return toAgent(requireRow(this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id), `agent ${id}`));
  }

  findByName(name: string): Agent | null {
    const row = this.db.prepare('SELECT * FROM agents WHERE name = ? COLLATE NOCASE').get(name);
    return row === undefined ? null : toAgent(row);
  }

  all(): Agent[] {
    return this.db.prepare('SELECT * FROM agents ORDER BY name').all().map(toAgent);
  }

  living(): Agent[] {
    return this.db
      .prepare("SELECT * FROM agents WHERE status <> 'dead' AND health > 0 ORDER BY name")
      .all()
      .map(toAgent);
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM agents').get();
    return row === undefined ? 0 : numberCol(row, 'n');
  }
}
