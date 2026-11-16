import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export type Db = DatabaseSync;

/** Central database location: ~/.hivemem/hivemem.db */
export const defaultDbPath = (): string => path.join(homedir(), '.hivemem', 'hivemem.db');

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  root_path  TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Multiple physical paths (mount points, case variants, moved roots) map to one project.
CREATE TABLE IF NOT EXISTS project_aliases (
  alias_path TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS memories (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('fact','decision','preference','procedure','episodic','snippet')),
  title           TEXT NOT NULL,
  content         TEXT NOT NULL,
  tags            TEXT NOT NULL DEFAULT '[]',
  importance      REAL NOT NULL DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1),
  pinned          INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','superseded')),
  supersedes      TEXT,
  source_agent    TEXT,
  session_id      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  last_accessed_at TEXT,
  expires_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(project_id, kind);

-- External-content FTS5 index. Trigram tokenizer gives substring matching that
-- also works for CJK; queries shorter than 3 code points fall back to LIKE.
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  title, content, tags,
  content='memories', content_rowid='rowid', tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts (rowid, title, content, tags)
  VALUES (new.rowid, new.title, new.content, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts (memories_fts, rowid, title, content, tags)
  VALUES ('delete', old.rowid, old.title, old.content, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts (memories_fts, rowid, title, content, tags)
  VALUES ('delete', old.rowid, old.title, old.content, old.tags);
  INSERT INTO memories_fts (rowid, title, content, tags)
  VALUES (new.rowid, new.title, new.content, new.tags);
END;

-- Append-only audit trail. No foreign keys on purpose: it must survive the
-- deletion of the rows it describes.
CREATE TABLE IF NOT EXISTS audit_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT NOT NULL,
  project_id TEXT,
  memory_id TEXT,
  action    TEXT NOT NULL,
  actor     TEXT,
  detail    TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_project ON audit_log(project_id, id DESC);
`;

// v2: derived semantic index. Vectors are Float32 BLOBs; brute-force cosine at
// this scale avoids any native extension dependency (node:sqlite cannot load
// extensions). embedding_meta is the palace-level embedder identity used by
// the three-state model-swap check.
const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS memory_embeddings (
  memory_id  TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  model_name TEXT NOT NULL,
  dim        INTEGER NOT NULL,
  vector     BLOB NOT NULL,
  embedded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS embedding_meta (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  model_name TEXT NOT NULL,
  dim        INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
`;

// v3: evolving-knowledge upsert and review cycle (Engram-inspired).
// topic_key turns memory_write into an upsert for evolving topics;
// revision_count tracks in-place revisions; review_after schedules a
// non-destructive "needs review" state for durable kinds.
const SCHEMA_V3 = `
ALTER TABLE memories ADD COLUMN topic_key TEXT;
ALTER TABLE memories ADD COLUMN revision_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE memories ADD COLUMN review_after TEXT;
CREATE INDEX IF NOT EXISTS idx_memories_topic ON memories(project_id, topic_key);
`;

// v4: memory scope hierarchy (user/project/device/agent). device/agent are
// context tags on rows, not containers — the strict tree
// user:project:device:agent stays a logical addressing model; physically it is
// a (project = P) ∧ (device ∈ {ctx, NULL}) ∧ (agent ∈ {ctx, NULL}) match, the
// same layering git config uses. User-level memories live in the reserved
// '@user' project row (see projects.ts) so memories.project_id stays NOT NULL:
// SQLite cannot ALTER a column constraint, and a reserved row reuses the
// FTS/TTL/brief machinery with zero table rebuild.
const SCHEMA_V4 = `
ALTER TABLE memories ADD COLUMN device TEXT;
ALTER TABLE memories ADD COLUMN agent TEXT;
CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(project_id, device, agent);
CREATE TABLE IF NOT EXISTS devices (
  name       TEXT PRIMARY KEY,
  first_seen TEXT NOT NULL,
  last_seen  TEXT NOT NULL,
  source     TEXT
);
`;

// v5: multi-user permissions (DESIGN.md §13.3). Credential separation: MCP
// tokens are stored as SHA-256 hashes (high-entropy random values), web
// passwords as scrypt hashes, web sessions as hashed cookies. Grants are
// project-granular — row-level grants would force per-row permission
// filtering after hybrid retrieval scoring. Project name uniqueness moves
// from global to (owner, name) so every user can have their own '@user' row;
// legacy rows keep owner NULL until the first user claims them.
const SCHEMA_V5 = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL DEFAULT 'default',
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS grants (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  grantor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  grantee_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at      TEXT NOT NULL,
  revoked_at      TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_grants_active
  ON grants(grantee_user_id, project_id) WHERE revoked_at IS NULL;

ALTER TABLE projects ADD COLUMN owner_user_id TEXT REFERENCES users(id);
`;

// v6: row versions, addressable history and evidence (PowerContext-inspired).
// HiveMem's core scenario is several agents writing concurrently, yet updates
// used to be last-write-wins. `version` is a monotonic CAS token bumped by every
// mutation; a caller that read version N can pass expected_version and a stale
// write is rejected instead of silently clobbering. `memory_revisions` stores
// the FULL previous row (not just the audit diff) keyed by the version it
// belonged to, so `memory_read(id, at_version=N)` can return an exact historical
// snapshot — audit_log stays the who/what trail, this is the content store.
// Evidence is a JSON array of typed locators ({kind, locator, quote}) so a
// memory can name the prompt/file/URL it came from; it rides on the row (no
// join, no N+1 on search hits) and into every revision snapshot.
const SCHEMA_V6 = `
ALTER TABLE memories ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE memories ADD COLUMN evidence TEXT NOT NULL DEFAULT '[]';

CREATE TABLE IF NOT EXISTS memory_revisions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id  TEXT NOT NULL,
  project_id TEXT NOT NULL,
  version    INTEGER NOT NULL,
  action     TEXT NOT NULL,
  actor      TEXT,
  ts         TEXT NOT NULL,
  snapshot   TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_revisions_memory ON memory_revisions(memory_id, version);
`;

const SCHEMA_MIGRATIONS: Array<{ to: number; ddl: string }> = [
  { to: 1, ddl: SCHEMA_V1 },
  { to: 2, ddl: SCHEMA_V2 },
  { to: 3, ddl: SCHEMA_V3 },
  { to: 4, ddl: SCHEMA_V4 },
  { to: 5, ddl: SCHEMA_V5 },
  { to: 6, ddl: SCHEMA_V6 },
];

const SCHEMA_VERSION = SCHEMA_MIGRATIONS.length;

/**
 * Open (creating if needed) the HiveMem database with the pragmas required for
 * multi-process use: WAL journaling, a 5s busy timeout, and enforced foreign keys.
 */
export function openDb(dbPath: string = defaultDbPath()): Db {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  for (const step of SCHEMA_MIGRATIONS) {
    if (version < step.to) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(step.ddl);
        db.exec(`PRAGMA user_version = ${step.to}`);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
  }
  return db;
}
