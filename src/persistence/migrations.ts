/**
 * Schema migrations.
 *
 * SQL lives in TypeScript rather than in `.sql` files so that `dist/` needs no
 * asset copying — the build stays a plain `tsc` invocation. Migrations are
 * append-only: never edit a shipped migration, add another.
 */

import type { Database } from './db.ts';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial',
    sql: `
      -- Simulation-level state: one row, id = 1.
      CREATE TABLE simulation (
        id                INTEGER PRIMARY KEY CHECK (id = 1),
        scenario          TEXT    NOT NULL,
        seed              INTEGER NOT NULL,
        started_at        INTEGER NOT NULL,
        -- Monotonic world ticks, maintained across day wraparound (ADR-0011).
        world_ticks       INTEGER NOT NULL DEFAULT 0,
        world_day         INTEGER NOT NULL DEFAULT 0,
        -- Last raw time_ticks seen from the environment, to detect wraparound.
        last_raw_ticks    INTEGER NOT NULL DEFAULT 0,
        weather           TEXT    NOT NULL DEFAULT 'clear',
        status            TEXT    NOT NULL DEFAULT 'running'
      ) STRICT;

      CREATE TABLE agents (
        id              TEXT    PRIMARY KEY,
        name            TEXT    NOT NULL UNIQUE,
        role            TEXT    NOT NULL,
        personality     TEXT    NOT NULL,   -- JSON
        skills          TEXT    NOT NULL,   -- JSON
        needs           TEXT    NOT NULL,   -- JSON
        x               REAL    NOT NULL,
        y               REAL    NOT NULL,
        z               REAL    NOT NULL,
        health          REAL    NOT NULL DEFAULT 1.0,
        status          TEXT    NOT NULL DEFAULT 'idle',
        phase           TEXT    NOT NULL DEFAULT 'observe',
        current_goal_id TEXT,
        last_tick_at    INTEGER NOT NULL DEFAULT 0,
        activity        TEXT    NOT NULL DEFAULT '',
        spawned_at_day  INTEGER NOT NULL DEFAULT 0
      ) STRICT;

      -- The authoritative history. Append-only: no UPDATE or DELETE path exists
      -- in the repository (requirement 21).
      CREATE TABLE events (
        seq          INTEGER PRIMARY KEY AUTOINCREMENT,
        id           TEXT    NOT NULL UNIQUE,
        type         TEXT    NOT NULL,
        day          INTEGER NOT NULL,
        world_ticks  INTEGER NOT NULL,
        actor_id     TEXT,
        payload      TEXT    NOT NULL,   -- JSON
        importance   REAL    NOT NULL,
        recorded_at  INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX events_day_idx        ON events (day);
      CREATE INDEX events_type_idx       ON events (type);
      CREATE INDEX events_actor_idx      ON events (actor_id);
      CREATE INDEX events_importance_idx ON events (importance);

      CREATE TABLE goals (
        id                TEXT    PRIMARY KEY,
        agent_id          TEXT    NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
        kind              TEXT    NOT NULL,
        params            TEXT    NOT NULL,   -- JSON
        state             TEXT    NOT NULL,
        priority          REAL    NOT NULL,
        reason            TEXT    NOT NULL,
        parent_goal_id    TEXT REFERENCES goals (id) ON DELETE SET NULL,
        created_at_day    INTEGER NOT NULL,
        created_at_ticks  INTEGER NOT NULL,
        resolved_at_ticks INTEGER,
        outcome           TEXT
      ) STRICT;

      CREATE INDEX goals_agent_state_idx ON goals (agent_id, state);

      CREATE TABLE plans (
        id               TEXT    PRIMARY KEY,
        goal_id          TEXT    NOT NULL REFERENCES goals (id) ON DELETE CASCADE,
        agent_id         TEXT    NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
        steps            TEXT    NOT NULL,   -- JSON array of PlanStep
        current_step     INTEGER NOT NULL DEFAULT 0,
        state            TEXT    NOT NULL DEFAULT 'active',
        created_at_ticks INTEGER NOT NULL,
        revision         INTEGER NOT NULL DEFAULT 0
      ) STRICT;

      CREATE INDEX plans_goal_idx        ON plans (goal_id);
      CREATE INDEX plans_agent_state_idx ON plans (agent_id, state);

      -- Memory is per-agent; there is no cross-agent query path (ADR-0007).
      CREATE TABLE memories (
        id                  TEXT    PRIMARY KEY,
        agent_id            TEXT    NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
        type                TEXT    NOT NULL,
        content             TEXT    NOT NULL,
        importance          REAL    NOT NULL,
        confidence          REAL    NOT NULL DEFAULT 1.0,
        source              TEXT    NOT NULL,   -- JSON KnowledgeSource
        related_entities    TEXT    NOT NULL DEFAULT '[]',  -- JSON
        tags                TEXT    NOT NULL DEFAULT '[]',  -- JSON
        created_at_day      INTEGER NOT NULL,
        created_at_ticks    INTEGER NOT NULL,
        last_accessed_ticks INTEGER NOT NULL,
        access_count        INTEGER NOT NULL DEFAULT 0,
        event_id            TEXT,
        consolidated_into   TEXT REFERENCES memories (id) ON DELETE SET NULL
      ) STRICT;

      CREATE INDEX memories_agent_type_idx  ON memories (agent_id, type);
      CREATE INDEX memories_retrieval_idx   ON memories (agent_id, consolidated_into, importance);

      CREATE TABLE known_locations (
        agent_id           TEXT    NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
        x                  INTEGER NOT NULL,
        y                  INTEGER NOT NULL,
        z                  INTEGER NOT NULL,
        kind               TEXT    NOT NULL,
        confidence         REAL    NOT NULL,
        source             TEXT    NOT NULL,   -- JSON KnowledgeSource
        label              TEXT    NOT NULL DEFAULT '',
        discovered_at_day  INTEGER NOT NULL,
        last_seen_at_ticks INTEGER NOT NULL,
        PRIMARY KEY (agent_id, x, y, z, kind)
      ) STRICT;

      CREATE TABLE known_resources (
        agent_id            TEXT    NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
        resource            TEXT    NOT NULL,
        x                   INTEGER NOT NULL,
        y                   INTEGER NOT NULL,
        z                   INTEGER NOT NULL,
        estimated_quantity  REAL    NOT NULL,
        confidence          REAL    NOT NULL,
        source              TEXT    NOT NULL,   -- JSON KnowledgeSource
        discovered_at_day   INTEGER NOT NULL,
        last_seen_at_ticks  INTEGER NOT NULL,
        PRIMARY KEY (agent_id, resource, x, y, z)
      ) STRICT;

      CREATE INDEX known_resources_lookup_idx
        ON known_resources (agent_id, resource, confidence);

      -- Asymmetric: (a -> b) and (b -> a) are separate rows.
      CREATE TABLE relationships (
        agent_id          TEXT    NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
        other_agent_id    TEXT    NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
        trust             REAL    NOT NULL DEFAULT 0,
        affinity          REAL    NOT NULL DEFAULT 0,
        familiarity       REAL    NOT NULL DEFAULT 0,
        interactions      INTEGER NOT NULL DEFAULT 0,
        last_event_id     TEXT,
        last_reason       TEXT,
        updated_at_ticks  INTEGER NOT NULL,
        PRIMARY KEY (agent_id, other_agent_id),
        CHECK (agent_id <> other_agent_id)
      ) STRICT;

      CREATE TABLE messages (
        id             TEXT    PRIMARY KEY,
        from_agent_id  TEXT    NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
        to_agent_id    TEXT    NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
        content        TEXT    NOT NULL,
        sent_at_ticks  INTEGER NOT NULL,
        sent_at_day    INTEGER NOT NULL,
        read_at_ticks  INTEGER
      ) STRICT;

      -- Unread messages for one recipient: the INTEGRATE-phase drain.
      CREATE INDEX messages_inbox_idx ON messages (to_agent_id, read_at_ticks);

      -- The resource ledger (ADR-0004). owner_id is an agent id or a settlement
      -- id; owner_kind disambiguates.
      CREATE TABLE resources (
        owner_id   TEXT    NOT NULL,
        owner_kind TEXT    NOT NULL CHECK (owner_kind IN ('agent', 'settlement')),
        resource   TEXT    NOT NULL,
        quantity   REAL    NOT NULL DEFAULT 0 CHECK (quantity >= 0),
        PRIMARY KEY (owner_id, owner_kind, resource)
      ) STRICT;

      -- Region reservations (ADR-0005). Expiry prevents a dead agent
      -- deadlocking a build site forever.
      CREATE TABLE reservations (
        id                TEXT    PRIMARY KEY,
        agent_id          TEXT    NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
        min_x INTEGER NOT NULL, min_y INTEGER NOT NULL, min_z INTEGER NOT NULL,
        max_x INTEGER NOT NULL, max_y INTEGER NOT NULL, max_z INTEGER NOT NULL,
        purpose           TEXT    NOT NULL DEFAULT '',
        created_at_ticks  INTEGER NOT NULL,
        expires_at_ticks  INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX reservations_expiry_idx ON reservations (expires_at_ticks);

      -- The audit trail behind every reasoning-influenced choice (ADR-0008).
      CREATE TABLE decisions (
        id            TEXT    PRIMARY KEY,
        agent_id      TEXT    NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
        category      TEXT    NOT NULL,
        world_ticks   INTEGER NOT NULL,
        day           INTEGER NOT NULL,
        observation   TEXT    NOT NULL,   -- JSON: what the agent could see
        memory_ids    TEXT    NOT NULL,   -- JSON: which memories were retrieved
        prompt        TEXT,
        response      TEXT,
        model         TEXT    NOT NULL,
        chosen_action TEXT    NOT NULL,
        event_id      TEXT,
        llm_call_id   TEXT
      ) STRICT;

      CREATE INDEX decisions_agent_idx ON decisions (agent_id, world_ticks);

      -- Token and cost instrumentation (requirement 29).
      CREATE TABLE llm_calls (
        id            TEXT    PRIMARY KEY,
        agent_id      TEXT,
        category      TEXT    NOT NULL,
        provider      TEXT    NOT NULL,
        model         TEXT    NOT NULL,
        input_tokens  INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd      REAL    NOT NULL DEFAULT 0,
        duration_ms   INTEGER NOT NULL DEFAULT 0,
        day           INTEGER NOT NULL DEFAULT 0,
        ok            INTEGER NOT NULL DEFAULT 1,
        error         TEXT,
        created_at    INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX llm_calls_category_idx ON llm_calls (category);
      CREATE INDEX llm_calls_agent_idx    ON llm_calls (agent_id);
      CREATE INDEX llm_calls_day_idx      ON llm_calls (day);
    `,
  },
  {
    version: 2,
    name: 'civilization',
    sql: `
      -- Civilization-level state, kept separate from any agent's private beliefs
      -- (requirement 19). These tables hold *observable public facts* — that a
      -- structure exists, that a project is claimed — not what anyone thinks.
      CREATE TABLE settlements (
        id            TEXT    PRIMARY KEY,
        name          TEXT    NOT NULL,
        objective     TEXT    NOT NULL,
        founding_day  INTEGER NOT NULL,
        center_x      REAL    NOT NULL,
        center_y      REAL    NOT NULL,
        center_z      REAL    NOT NULL,
        status        TEXT    NOT NULL DEFAULT 'active'
      ) STRICT;

      -- A structure exists because a build was verified. The event ledger is
      -- still authoritative; this is the queryable projection of it.
      CREATE TABLE structures (
        id                TEXT    PRIMARY KEY,
        settlement_id     TEXT REFERENCES settlements (id) ON DELETE SET NULL,
        type              TEXT    NOT NULL,
        blueprint         TEXT    NOT NULL,
        min_x INTEGER NOT NULL, min_y INTEGER NOT NULL, min_z INTEGER NOT NULL,
        max_x INTEGER NOT NULL, max_y INTEGER NOT NULL, max_z INTEGER NOT NULL,
        builders          TEXT    NOT NULL DEFAULT '[]',  -- JSON array of agent ids
        purpose           TEXT    NOT NULL DEFAULT '',
        -- planned | building | complete | damaged | ruined
        state             TEXT    NOT NULL DEFAULT 'complete',
        created_at_day    INTEGER NOT NULL,
        created_at_ticks  INTEGER NOT NULL,
        verified_at_ticks INTEGER
      ) STRICT;

      CREATE INDEX structures_type_idx       ON structures (type);
      CREATE INDEX structures_settlement_idx ON structures (settlement_id, state);

      -- Shared work the settlement wants doing. Distinct from an agent's goal:
      -- a project outlives whoever is currently working on it, which is what
      -- lets several agents contribute to one shelter instead of five.
      CREATE TABLE projects (
        id                 TEXT    PRIMARY KEY,
        settlement_id      TEXT    NOT NULL REFERENCES settlements (id) ON DELETE CASCADE,
        kind               TEXT    NOT NULL,
        blueprint          TEXT,
        requirements       TEXT    NOT NULL DEFAULT '{}',  -- JSON ResourceBundle
        site_x INTEGER, site_y INTEGER, site_z INTEGER,
        -- proposed | active | blocked | completed | abandoned
        state              TEXT    NOT NULL DEFAULT 'proposed',
        priority           REAL    NOT NULL DEFAULT 0.5,
        reason             TEXT    NOT NULL DEFAULT '',
        created_at_day     INTEGER NOT NULL,
        created_at_ticks   INTEGER NOT NULL,
        completed_at_ticks INTEGER,
        structure_id       TEXT REFERENCES structures (id) ON DELETE SET NULL
      ) STRICT;

      CREATE INDEX projects_state_idx ON projects (settlement_id, state);

      -- Who has taken on which part of a project. This is the public
      -- announcement of intent that division of labour rests on (requirement 18)
      -- — agents read claims, never each other's private plans.
      CREATE TABLE project_claims (
        project_id        TEXT    NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
        agent_id          TEXT    NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
        role              TEXT    NOT NULL,
        claimed_at_ticks  INTEGER NOT NULL,
        released_at_ticks INTEGER,
        PRIMARY KEY (project_id, agent_id)
      ) STRICT;

      CREATE INDEX project_claims_agent_idx ON project_claims (agent_id, released_at_ticks);

      -- Generated history. The event_ids column is the evidence each entry was
      -- built from, so any sentence can be traced back to the ledger (ADR-0009).
      CREATE TABLE chronicle_entries (
        id           TEXT    PRIMARY KEY,
        day          INTEGER NOT NULL UNIQUE,
        title        TEXT    NOT NULL,
        prose        TEXT    NOT NULL,
        event_ids    TEXT    NOT NULL DEFAULT '[]',  -- JSON array
        -- narrated (model prose, verified) | rendered (deterministic fallback)
        source       TEXT    NOT NULL DEFAULT 'rendered',
        generated_at INTEGER NOT NULL
      ) STRICT;
    `,
  },
];

/** Highest migration version this build knows about. */
export const SCHEMA_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

function currentVersion(db: Database): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT    NOT NULL,
      applied_at INTEGER NOT NULL
    ) STRICT
  `);
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get();
  const value = row?.version;
  return typeof value === 'number' ? value : 0;
}

/**
 * Bring the database up to `SCHEMA_VERSION`. Idempotent, so it is safe to call
 * on every startup. Returns the versions actually applied.
 */
export function migrate(db: Database, now: number = Date.now()): number[] {
  const from = currentVersion(db);
  const pending = MIGRATIONS.filter((m) => m.version > from).sort((a, b) => a.version - b.version);
  if (pending.length === 0) return [];

  const record = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );

  // Each migration is its own transaction: a failure at version 3 leaves 1 and
  // 2 applied rather than rolling the whole schema back to nothing.
  for (const migration of pending) {
    db.transaction(() => {
      db.exec(migration.sql);
      record.run(migration.version, migration.name, now);
    });
  }

  return pending.map((m) => m.version);
}

/**
 * Guard against opening a database written by a newer build. Downgrading would
 * silently drop columns the old code doesn't know to write.
 */
export function assertSchemaCompatible(db: Database): void {
  const version = currentVersion(db);
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `database schema is version ${version}, but this build understands up to ` +
        `${SCHEMA_VERSION}. Upgrade Worldloom or use a different database file.`,
    );
  }
}
