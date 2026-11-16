import { hostname } from 'node:os';
import type { Db } from './db.js';
import { USER_PROJECT_NAME, USER_PROJECT_ID } from './projects.js';
import { nowIso } from './util.js';

/**
 * Memory scope hierarchy (DESIGN.md §13): user → project → device → agent.
 * The strict tree user:project:device:agent is a logical addressing model;
 * physically device/agent are context tags on memory rows and user-level
 * memories live in '@user' project rows — one per user in multi-user mode
 * (plus the legacy fixed-id row), so scope derivation must resolve the set
 * of '@user' project ids, not a single constant.
 */
export type Scope = 'user' | 'project' | 'device' | 'agent';

/** Request context used to match and tag scoped memories. */
export interface ScopeContext {
  /** Requesting device (X-HiveMem-Device header, hostname fallback). */
  device: string | null;
  /** Requesting agent tool (X-HiveMem-Agent header), e.g. 'dsh'. */
  agent: string | null;
}

/** Structural subset of Memory rows used to derive scope. */
export interface ScopeTags {
  project_id: string;
  device: string | null;
  agent: string | null;
}

/** All project rows that hold user-level memories ('@user' by name). */
export function userProjectIds(db: Db): Set<string> {
  const rows = db
    .prepare('SELECT id FROM projects WHERE lower(name) = ?')
    .all(USER_PROJECT_NAME) as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

/** Derive a memory's scope from its project id and context tags. */
export function scopeOf(m: ScopeTags, userIds?: Set<string>): Scope {
  const isUser = userIds ? userIds.has(m.project_id) : m.project_id === USER_PROJECT_ID;
  if (isUser) return 'user';
  // Agent-first, mirroring scopeCondition: `device=NULL ∧ agent='zcode'` is an
  // agent-scope row that applies on every device (DESIGN.md §13 flexibility).
  if (m.agent !== null && m.agent !== undefined) return 'agent';
  if (m.device !== null && m.device !== undefined) return 'device';
  return 'project';
}

/** Normalize a device/agent name: trim, lowercase, spaces → dashes. */
export function normalizeScopeName(raw: string | undefined | null): string | null {
  const v = (raw ?? '').trim().toLowerCase().replaceAll(/\s+/g, '-');
  return v || null;
}

/**
 * Resolve the requesting device: an explicit X-HiveMem-Device header wins;
 * the hostname fallback keeps single-box setups zero-config.
 */
export function resolveDevice(header: string | undefined | null): string | null {
  return normalizeScopeName(header) ?? normalizeScopeName(hostname());
}

/** Auto-register a device on first sight (anti-fragmentation registry). */
export function registerDevice(db: Db, name: string, source: string): void {
  const now = nowIso();
  db.prepare(
    `INSERT INTO devices (name, first_seen, last_seen, source) VALUES (?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET last_seen = excluded.last_seen`,
  ).run(name, now, now, source);
}

export interface DeviceRow {
  name: string;
  first_seen: string;
  last_seen: string;
  source: string | null;
}

export function listDevices(db: Db): DeviceRow[] {
  return db
    .prepare('SELECT name, first_seen, last_seen, source FROM devices ORDER BY last_seen DESC')
    .all() as unknown as DeviceRow[];
}

/**
 * Resolve the (device, agent) tags a write in the given scope should carry.
 * Values always come from request context, never typed by hand — that is
 * what keeps device names from fragmenting.
 */
export function tagsForScope(
  scope: Scope,
  ctx: ScopeContext,
): { device: string | null; agent: string | null } {
  switch (scope) {
    case 'user':
      return { device: null, agent: null };
    case 'project':
      return { device: null, agent: null };
    case 'device':
      return { device: ctx.device, agent: null };
    case 'agent':
      return { device: ctx.device, agent: ctx.agent };
  }
}

/** SQL condition (with `m.` alias) restricting rows to one scope layer. */
export function scopeCondition(scope: Scope): string {
  switch (scope) {
    case 'user':
      // '@user' rows exist per user in multi-user mode (random ids, reserved
      // name) plus the legacy fixed-id row — resolve by name so the filter
      // matches every viewer's user-level memories.
      return `m.project_id IN (SELECT id FROM projects WHERE lower(name) = '${USER_PROJECT_NAME}')`;
    case 'project':
      return `m.project_id NOT IN (SELECT id FROM projects WHERE lower(name) = '${USER_PROJECT_NAME}') AND m.device IS NULL AND m.agent IS NULL`;
    case 'device':
      return `m.project_id NOT IN (SELECT id FROM projects WHERE lower(name) = '${USER_PROJECT_NAME}') AND m.device IS NOT NULL AND m.agent IS NULL`;
    case 'agent':
      return `m.project_id NOT IN (SELECT id FROM projects WHERE lower(name) = '${USER_PROJECT_NAME}') AND m.agent IS NOT NULL`;
  }
}
