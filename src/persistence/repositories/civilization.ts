/**
 * Settlement, structure and project persistence.
 *
 * Unlike the per-agent repositories, these are deliberately *not* scoped by
 * agent: they hold public facts every settler can observe, which is the one
 * narrow exception ADR-0007 carves out of the knowledge-boundary rule. Nothing
 * here stores an opinion.
 */

import type { AgentId, ProjectId, SettlementId, StructureId } from '../../core/ids.ts';
import type { Region, ResourceBundle } from '../../core/world.ts';
import type {
  ChronicleEntry,
  Project,
  ProjectClaim,
  ProjectState,
  Settlement,
  Structure,
  StructureState,
} from '../../civilization/types.ts';
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

function toSettlement(row: Row): Settlement {
  return {
    id: textCol(row, 'id') as SettlementId,
    name: textCol(row, 'name'),
    objective: textCol(row, 'objective'),
    foundingDay: numberCol(row, 'founding_day'),
    center: { x: numberCol(row, 'center_x'), y: numberCol(row, 'center_y'), z: numberCol(row, 'center_z') },
    status: textCol(row, 'status') as Settlement['status'],
  };
}

function regionOf(row: Row): Region {
  return {
    min: { x: numberCol(row, 'min_x'), y: numberCol(row, 'min_y'), z: numberCol(row, 'min_z') },
    max: { x: numberCol(row, 'max_x'), y: numberCol(row, 'max_y'), z: numberCol(row, 'max_z') },
  };
}

function toStructure(row: Row): Structure {
  return {
    id: textCol(row, 'id') as StructureId,
    settlementId: nullableTextCol(row, 'settlement_id') as SettlementId | null,
    type: textCol(row, 'type'),
    blueprint: textCol(row, 'blueprint'),
    region: regionOf(row),
    builders: jsonCol<AgentId[]>(row, 'builders'),
    purpose: textCol(row, 'purpose'),
    state: textCol(row, 'state') as StructureState,
    createdAtDay: numberCol(row, 'created_at_day'),
    createdAtTicks: numberCol(row, 'created_at_ticks'),
    verifiedAtTicks: nullableNumberCol(row, 'verified_at_ticks'),
  };
}

function toProject(row: Row): Project {
  const x = nullableNumberCol(row, 'site_x');
  const y = nullableNumberCol(row, 'site_y');
  const z = nullableNumberCol(row, 'site_z');
  return {
    id: textCol(row, 'id') as ProjectId,
    settlementId: textCol(row, 'settlement_id') as SettlementId,
    kind: textCol(row, 'kind'),
    blueprint: nullableTextCol(row, 'blueprint'),
    requirements: jsonCol<ResourceBundle>(row, 'requirements'),
    site: x === null || y === null || z === null ? null : { x, y, z },
    state: textCol(row, 'state') as ProjectState,
    priority: numberCol(row, 'priority'),
    reason: textCol(row, 'reason'),
    createdAtDay: numberCol(row, 'created_at_day'),
    createdAtTicks: numberCol(row, 'created_at_ticks'),
    completedAtTicks: nullableNumberCol(row, 'completed_at_ticks'),
    structureId: nullableTextCol(row, 'structure_id') as StructureId | null,
  };
}

export class SettlementRepository {
  constructor(private readonly db: Database) {}

  /** Create the settlement if it isn't already there. Idempotent, so a restart
   *  doesn't found a second one. */
  upsert(settlement: Settlement): Settlement {
    this.db
      .prepare(
        `INSERT INTO settlements (id, name, objective, founding_day, center_x, center_y, center_z, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, status = excluded.status`,
      )
      .run(
        settlement.id,
        settlement.name,
        settlement.objective,
        settlement.foundingDay,
        settlement.center.x,
        settlement.center.y,
        settlement.center.z,
        settlement.status,
      );
    return this.get(settlement.id);
  }

  get(id: SettlementId): Settlement {
    return toSettlement(
      requireRow(this.db.prepare('SELECT * FROM settlements WHERE id = ?').get(id), `settlement ${id}`),
    );
  }

  find(id: SettlementId): Settlement | null {
    const row = this.db.prepare('SELECT * FROM settlements WHERE id = ?').get(id);
    return row === undefined ? null : toSettlement(row);
  }

  /** V0 runs one settlement; this is how the rest of the code finds it. */
  primary(): Settlement | null {
    const row = this.db
      .prepare("SELECT * FROM settlements WHERE status = 'active' ORDER BY founding_day LIMIT 1")
      .get();
    return row === undefined ? null : toSettlement(row);
  }

  all(): Settlement[] {
    return this.db.prepare('SELECT * FROM settlements ORDER BY founding_day').all().map(toSettlement);
  }
}

export class StructureRepository {
  constructor(private readonly db: Database) {}

  insert(structure: Structure): void {
    this.db
      .prepare(
        `INSERT INTO structures (id, settlement_id, type, blueprint,
                                 min_x, min_y, min_z, max_x, max_y, max_z,
                                 builders, purpose, state,
                                 created_at_day, created_at_ticks, verified_at_ticks)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        structure.id,
        structure.settlementId,
        structure.type,
        structure.blueprint,
        structure.region.min.x,
        structure.region.min.y,
        structure.region.min.z,
        structure.region.max.x,
        structure.region.max.y,
        structure.region.max.z,
        toJson(structure.builders),
        structure.purpose,
        structure.state,
        structure.createdAtDay,
        structure.createdAtTicks,
        structure.verifiedAtTicks,
      );
  }

  setState(id: StructureId, state: StructureState, verifiedAtTicks?: number): void {
    this.db
      .prepare(
        `UPDATE structures SET state = ?,
            verified_at_ticks = COALESCE(?, verified_at_ticks)
          WHERE id = ?`,
      )
      .run(state, verifiedAtTicks ?? null, id);
  }

  /** Record another agent as having worked on this structure. */
  addBuilder(id: StructureId, agentId: AgentId): void {
    const structure = this.find(id);
    if (structure === null || structure.builders.includes(agentId)) return;
    this.db
      .prepare('UPDATE structures SET builders = ? WHERE id = ?')
      .run(toJson([...structure.builders, agentId]), id);
  }

  find(id: StructureId): Structure | null {
    const row = this.db.prepare('SELECT * FROM structures WHERE id = ?').get(id);
    return row === undefined ? null : toStructure(row);
  }

  all(): Structure[] {
    return this.db.prepare('SELECT * FROM structures ORDER BY created_at_ticks').all().map(toStructure);
  }

  /** Structures that are standing, of a type. The question "does the settlement
   *  have shelter yet?" resolves to this. */
  ofType(type: string): Structure[] {
    return this.db
      .prepare(
        `SELECT * FROM structures WHERE type = ? AND state IN ('complete', 'damaged')
          ORDER BY created_at_ticks`,
      )
      .all(type)
      .map(toStructure);
  }

  /** Distinct types the settlement currently has standing. */
  standingTypes(): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT type FROM structures WHERE state IN ('complete', 'damaged')")
      .all();
    return rows.map((row) => textCol(row, 'type'));
  }

  /** Whether anything already occupies a region, so two agents don't build on
   *  the same ground. */
  overlapping(region: Region): Structure[] {
    return this.db
      .prepare(
        `SELECT * FROM structures
          WHERE min_x <= ? AND max_x >= ? AND min_y <= ? AND max_y >= ? AND min_z <= ? AND max_z >= ?
            AND state <> 'ruined'`,
      )
      .all(
        region.max.x,
        region.min.x,
        region.max.y,
        region.min.y,
        region.max.z,
        region.min.z,
      )
      .map(toStructure);
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM structures').get();
    return row === undefined ? 0 : numberCol(row, 'n');
  }
}

export class ProjectRepository {
  constructor(private readonly db: Database) {}

  insert(project: Project): void {
    this.db
      .prepare(
        `INSERT INTO projects (id, settlement_id, kind, blueprint, requirements,
                               site_x, site_y, site_z, state, priority, reason,
                               created_at_day, created_at_ticks, completed_at_ticks, structure_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        project.id,
        project.settlementId,
        project.kind,
        project.blueprint,
        toJson(project.requirements),
        project.site?.x ?? null,
        project.site?.y ?? null,
        project.site?.z ?? null,
        project.state,
        project.priority,
        project.reason,
        project.createdAtDay,
        project.createdAtTicks,
        project.completedAtTicks,
        project.structureId,
      );
  }

  update(project: Project): void {
    const result = this.db
      .prepare(
        `UPDATE projects SET kind = ?, blueprint = ?, requirements = ?,
            site_x = ?, site_y = ?, site_z = ?, state = ?, priority = ?, reason = ?,
            completed_at_ticks = ?, structure_id = ?
          WHERE id = ?`,
      )
      .run(
        project.kind,
        project.blueprint,
        toJson(project.requirements),
        project.site?.x ?? null,
        project.site?.y ?? null,
        project.site?.z ?? null,
        project.state,
        project.priority,
        project.reason,
        project.completedAtTicks,
        project.structureId,
        project.id,
      );
    if (Number(result.changes) === 0) {
      throw new Error(`cannot update unknown project ${project.id}`);
    }
  }

  find(id: ProjectId): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    return row === undefined ? null : toProject(row);
  }

  /** Work still to be done, highest priority first. */
  open(): Project[] {
    return this.db
      .prepare(
        `SELECT * FROM projects WHERE state IN ('proposed', 'active')
          ORDER BY priority DESC, created_at_ticks ASC`,
      )
      .all()
      .map(toProject);
  }

  all(): Project[] {
    return this.db.prepare('SELECT * FROM projects ORDER BY created_at_ticks').all().map(toProject);
  }

  ofKind(kind: string, blueprint?: string): Project[] {
    const sql =
      blueprint === undefined
        ? 'SELECT * FROM projects WHERE kind = ? ORDER BY created_at_ticks'
        : 'SELECT * FROM projects WHERE kind = ? AND blueprint = ? ORDER BY created_at_ticks';
    const params = blueprint === undefined ? [kind] : [kind, blueprint];
    return this.db.prepare(sql).all(...params).map(toProject);
  }

  // ── Claims ────────────────────────────────────────────────────────────────

  /** Take on part of a project. Announced intent, readable by everyone — this is
   *  what division of labour is built on (requirement 18). */
  claim(projectId: ProjectId, agentId: AgentId, role: string, atTicks: number): void {
    this.db
      .prepare(
        `INSERT INTO project_claims (project_id, agent_id, role, claimed_at_ticks, released_at_ticks)
         VALUES (?, ?, ?, ?, NULL)
         ON CONFLICT (project_id, agent_id) DO UPDATE SET
           role = excluded.role,
           claimed_at_ticks = excluded.claimed_at_ticks,
           released_at_ticks = NULL`,
      )
      .run(projectId, agentId, role, atTicks);
  }

  release(projectId: ProjectId, agentId: AgentId, atTicks: number): void {
    this.db
      .prepare(
        `UPDATE project_claims SET released_at_ticks = ?
          WHERE project_id = ? AND agent_id = ? AND released_at_ticks IS NULL`,
      )
      .run(atTicks, projectId, agentId);
  }

  /** Who is currently working on a project, and at what. */
  claimsFor(projectId: ProjectId): ProjectClaim[] {
    return this.db
      .prepare(
        `SELECT * FROM project_claims WHERE project_id = ? AND released_at_ticks IS NULL
          ORDER BY claimed_at_ticks`,
      )
      .all(projectId)
      .map((row) => toClaim(row));
  }

  /** What this agent has taken on. */
  claimsBy(agentId: AgentId): ProjectClaim[] {
    return this.db
      .prepare(
        `SELECT * FROM project_claims WHERE agent_id = ? AND released_at_ticks IS NULL
          ORDER BY claimed_at_ticks`,
      )
      .all(agentId)
      .map((row) => toClaim(row));
  }

  /** Every live claim, so an agent can see what is already covered without
   *  reading anyone's private state. */
  allClaims(): ProjectClaim[] {
    return this.db
      .prepare('SELECT * FROM project_claims WHERE released_at_ticks IS NULL')
      .all()
      .map((row) => toClaim(row));
  }
}

function toClaim(row: Row): ProjectClaim {
  return {
    projectId: textCol(row, 'project_id') as ProjectId,
    agentId: textCol(row, 'agent_id') as AgentId,
    role: textCol(row, 'role'),
    claimedAtTicks: numberCol(row, 'claimed_at_ticks'),
    releasedAtTicks: nullableNumberCol(row, 'released_at_ticks'),
  };
}

export class ChronicleRepository {
  constructor(private readonly db: Database) {}

  /** Store (or replace) a day's entry. Replacing is allowed so a chronicle can
   *  be regenerated after a fix without wiping the ledger it came from. */
  upsert(entry: ChronicleEntry): void {
    this.db
      .prepare(
        `INSERT INTO chronicle_entries (id, day, title, prose, event_ids, source, generated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (day) DO UPDATE SET
           title = excluded.title,
           prose = excluded.prose,
           event_ids = excluded.event_ids,
           source = excluded.source,
           generated_at = excluded.generated_at`,
      )
      .run(
        entry.id,
        entry.day,
        entry.title,
        entry.prose,
        toJson(entry.eventIds),
        entry.source,
        entry.generatedAt,
      );
  }

  forDay(day: number): ChronicleEntry | null {
    const row = this.db.prepare('SELECT * FROM chronicle_entries WHERE day = ?').get(day);
    return row === undefined ? null : toEntry(row);
  }

  all(): ChronicleEntry[] {
    return this.db
      .prepare('SELECT * FROM chronicle_entries ORDER BY day')
      .all()
      .map((row) => toEntry(row));
  }

  latestDay(): number | null {
    const row = this.db.prepare('SELECT MAX(day) AS day FROM chronicle_entries').get();
    const value = row?.day;
    return typeof value === 'number' ? value : null;
  }
}

function toEntry(row: Row): ChronicleEntry {
  return {
    id: textCol(row, 'id'),
    day: numberCol(row, 'day'),
    title: textCol(row, 'title'),
    prose: textCol(row, 'prose'),
    eventIds: jsonCol<string[]>(row, 'event_ids'),
    source: textCol(row, 'source') as ChronicleEntry['source'],
    generatedAt: numberCol(row, 'generated_at'),
  };
}
