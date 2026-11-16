import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Db } from './db.js';
import { HiveMemError, newProjectId, nowIso } from './util.js';

export interface ProjectRow {
  id: string;
  name: string;
  root_path: string | null;
  /** Owning user (multi-user mode); NULL = legacy/unowned. */
  owner_user_id: string | null;
  created_at: string;
  updated_at: string;
}

export const MARKER_DIR = '.hivemem';
export const MARKER_FILE = 'project.json';

/** Reserved project holding user-level (cross-project) memories. */
export const USER_PROJECT_NAME = '@user';
export const USER_PROJECT_ID = 'prj_user';

interface MarkerDoc {
  schema_version: number;
  id: string;
  name: string;
  created_at: string;
}

/**
 * Canonical key for a filesystem path: realpath-resolved, forward slashes,
 * lowercased on Windows (case-insensitive filesystems). Git remotes, host
 * names, user names and PIDs deliberately take no part in identity.
 */
export function normalizeKey(inputPath: string): string {
  let resolved: string;
  try {
    resolved = realpathSync(inputPath);
  } catch {
    resolved = path.resolve(inputPath);
  }
  let key = resolved.split(path.sep).join('/');
  if (process.platform === 'win32') key = key.toLowerCase();
  return key;
}

/**
 * Platform-independent absolute-path detection for project references.
 * `path.isAbsolute` alone is not enough in centralized (HTTP) mode: a Windows
 * client's `C:\…` or UNC `\\host\share` reference is not absolute under POSIX,
 * so a Linux hub would skip the path branch entirely and every path reference
 * from Windows clients would fail with PROJECT_NOT_FOUND.
 */
export function isPathRef(ref: string): boolean {
  return path.isAbsolute(ref) || /^[A-Za-z]:[\\/]/.test(ref) || ref.startsWith('\\\\');
}

/**
 * Normalize a path reference the way the *client* machine would, without
 * touching the hub's filesystem: backslashes become forward slashes and
 * Windows-style roots are lowercased (mirroring normalizeKey's win32 branch).
 * Used for registry lookup when the hub cannot see the client's filesystem.
 */
export function normalizePathRef(ref: string): string {
  let key = ref.replace(/\\/g, '/');
  const windowsStyle = /^[A-Za-z]:\//.test(key) || key.startsWith('//');
  if (windowsStyle) key = key.toLowerCase();
  if (key.length > 1) key = key.replace(/\/+$/, '');
  return key;
}

/** Walk up from `start` looking for a .hivemem/project.json marker. */
export function findProjectRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, MARKER_DIR, MARKER_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readMarker(root: string): MarkerDoc | null {
  try {
    const raw = readFileSync(path.join(root, MARKER_DIR, MARKER_FILE), 'utf8');
    const doc = JSON.parse(raw) as MarkerDoc;
    if (typeof doc.id === 'string' && doc.id) return doc;
    return null;
  } catch {
    return null;
  }
}

function writeMarker(root: string, doc: MarkerDoc): void {
  mkdirSync(path.join(root, MARKER_DIR), { recursive: true });
  writeFileSync(path.join(root, MARKER_DIR, MARKER_FILE), JSON.stringify(doc, null, 2) + '\n', 'utf8');
}

// The marker is meant to be COMMITTED with the repository: identity then travels
// through git, so clones on other machines or at other paths resolve to the
// same project. Repos that prefer per-clone identity can gitignore .hivemem/.

function getProject(db: Db, id: string): ProjectRow | null {
  return (db
    .prepare('SELECT id, name, root_path, owner_user_id, created_at, updated_at FROM projects WHERE id = ?')
    .get(id) as ProjectRow | undefined) ?? null;
}

/**
 * Register (idempotently) the project rooted at `rootDir`.
 *
 * - An existing path alias wins immediately: the same physical directory always
 *   resolves to the same project, whatever the marker says.
 * - Otherwise an existing marker's id is adopted, so identity survives moves
 *   and remounts.
 * - Otherwise a fresh identity is minted; when `withMarker` is set the marker
 *   file is written so future sessions resolve to the same id.
 */
/**
 * Names are the primary agent-facing reference, so they must be unique.
 * On collision, registration appends -2, -3, … (case-insensitive check).
 */
/**
 * Names are the primary agent-facing reference, so they must be unique —
 * per owner in multi-user mode (every user may have their own '@user' row),
 * globally in legacy single-user mode. On collision, registration appends
 * -2, -3, … (case-insensitive check). '@user' is always reserved.
 */
export function uniqueName(db: Db, candidate: string, selfId?: string, ownerId?: string | null): string {
  const base = candidate.trim() || 'project';
  let name = base;
  let n = 2;
  for (;;) {
    // '@user' is reserved for user-level memories even before the row exists.
    const reserved = name.toLowerCase() === USER_PROJECT_NAME;
    const row = reserved
      ? { id: USER_PROJECT_ID }
      : (db
          .prepare('SELECT id FROM projects WHERE lower(name) = lower(?) AND (owner_user_id IS ?)')
          .get(name, ownerId ?? null) as { id: string } | undefined);
    if (!row || row.id === selfId) return name;
    name = `${base}-${n++}`;
  }
}

export function ensureProject(
  db: Db,
  rootDir: string,
  options?: { name?: string; withMarker?: boolean; ownerUserId?: string | null },
): ProjectRow {
  const key = normalizeKey(rootDir);
  const absRoot = path.resolve(rootDir);
  const ownerId = options?.ownerUserId ?? null;

  const alias = db
    .prepare('SELECT project_id FROM project_aliases WHERE alias_path = ?')
    .get(key) as { project_id: string } | undefined;
  if (alias) {
    const row = getProject(db, alias.project_id);
    if (row) {
      if (options?.withMarker && !existsSync(path.join(absRoot, MARKER_DIR, MARKER_FILE))) {
        writeMarker(absRoot, { schema_version: 1, id: row.id, name: row.name, created_at: row.created_at });
      }
      return row;
    }
  }

  const marker = readMarker(absRoot);
  const id = marker?.id ?? newProjectId();
  const candidateName = marker?.name ?? options?.name ?? (path.basename(absRoot) || 'project');
  const now = nowIso();
  // Fresh rows get a collision-free name (within the owner's scope) so name
  // references stay unambiguous.
  const existingRow = getProject(db, id);
  const name = existingRow ? existingRow.name : uniqueName(db, candidateName, undefined, ownerId);
  db.prepare(
    'INSERT OR IGNORE INTO projects (id, name, root_path, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, name, key, ownerId, marker?.created_at ?? now, now);
  db.prepare('INSERT OR REPLACE INTO project_aliases (alias_path, project_id) VALUES (?, ?)').run(key, id);

  if (options?.withMarker !== false && !marker) {
    writeMarker(absRoot, { schema_version: 1, id, name, created_at: now });
  }

  const row = getProject(db, id);
  if (!row) throw new HiveMemError('DB_ERROR', 'project row missing after registration');
  return row;
}

/**
 * The reserved '@user' project: user-level memories (cross-project identity,
 * capabilities, preferences). It has no directory, no marker and no alias —
 * it is never resolved from a filesystem path, only by its reserved name.
 *
 * In legacy single-user mode there is exactly one row with the fixed id
 * below. In multi-user mode every user owns a private '@user' row (project
 * name uniqueness is per owner), resolved through the requesting user's id.
 */
export function ensureUserProject(db: Db, ownerId?: string | null): ProjectRow {
  if (ownerId) {
    const existing = db
      .prepare("SELECT id, name, root_path, owner_user_id, created_at, updated_at FROM projects WHERE lower(name) = lower(?) AND owner_user_id = ?")
      .get(USER_PROJECT_NAME, ownerId) as ProjectRow | undefined;
    if (existing) return existing;
    const id = newProjectId();
    const now = nowIso();
    db.prepare(
      'INSERT INTO projects (id, name, root_path, owner_user_id, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?)',
    ).run(id, USER_PROJECT_NAME, ownerId, now, now);
    const row = getProject(db, id);
    if (!row) throw new HiveMemError('DB_ERROR', 'user project row missing after creation');
    return row;
  }
  const existing = getProject(db, USER_PROJECT_ID);
  if (existing) return existing;
  const now = nowIso();
  db.prepare(
    'INSERT OR IGNORE INTO projects (id, name, root_path, owner_user_id, created_at, updated_at) VALUES (?, ?, NULL, NULL, ?, ?)',
  ).run(USER_PROJECT_ID, USER_PROJECT_NAME, now, now);
  const row = getProject(db, USER_PROJECT_ID);
  if (!row) throw new HiveMemError('DB_ERROR', 'user project row missing after creation');
  return row;
}

/**
 * Create a project by explicit name (no directory, no marker). Shared by the
 * REST API and the MCP bootstrap auto-registration — the centralized-hub
 * equivalent of stdio's CWD registration: a session-start bootstrap with a
 * new workspace name registers the project before any memory is written.
 * Uniqueness is scoped to the owner (multi-user) / global (legacy).
 */
export function createNamedProject(
  db: Db,
  input: { name: string; ownerUserId?: string | null },
): ProjectRow {
  const name = input.name.trim();
  if (!name) throw new HiveMemError('INVALID_INPUT', '项目名不能为空');
  if (name.toLowerCase() === USER_PROJECT_NAME) {
    throw new HiveMemError('RESERVED_NAME', '"@user" 是保留项目名（用户级记忆），不能手动创建');
  }
  const ownerId = input.ownerUserId ?? null;
  const taken = db
    .prepare('SELECT id FROM projects WHERE lower(name) = lower(?) AND (owner_user_id IS ?)')
    .get(name, ownerId) as { id: string } | undefined;
  if (taken) {
    throw new HiveMemError('PROJECT_EXISTS', `项目名 "${name}" 已存在（${taken.id}）`, {
      detail: { project_id: taken.id },
    });
  }
  const id = newProjectId();
  const now = nowIso();
  db.prepare(
    'INSERT INTO projects (id, name, root_path, owner_user_id, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?)',
  ).run(id, name, ownerId, now, now);
  const row = getProject(db, id);
  if (!row) throw new HiveMemError('DB_ERROR', 'project row missing after creation');
  return row;
}

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

/** Absolute path of a project's identity marker (null when there is no root_path). */
export function markerPathOf(rootPath: string | null | undefined): string | null {
  return rootPath ? path.join(rootPath, MARKER_DIR, MARKER_FILE) : null;
}

/**
 * Whether the marker file is visible from THIS host. In centralized mode the
 * project directory usually lives on a client machine, so a false answer means
 * "cannot tell from here", not "no marker".
 */
export function hasMarker(rootPath: string | null | undefined): boolean {
  const file = markerPathOf(rootPath);
  return Boolean(file && existsSync(file));
}

export interface DeleteProjectResult {
  id: string;
  name: string;
  root_path: string | null;
  /** Rows removed with the project (all of them, any status/scope). */
  memories: number;
  aliases: number;
  grants: number;
  /** Marker state on the hub's own filesystem (see hasMarker). */
  marker_existed: boolean;
  marker_removed: boolean;
}

/**
 * Permanently delete a project and everything hanging off it. Memories,
 * embeddings, path aliases and grants all cascade (see db.ts); the audit trail
 * deliberately survives, because audit_log has no foreign keys — the deletion
 * itself is recorded as a `project_delete` entry before the rows disappear.
 *
 * The reserved '@user' row is refused: it is the container of user-level
 * memories and the hub recreates it on demand, so "deleting" it would either
 * resurrect it empty or silently drop cross-project context.
 *
 * `removeMarker` handles the one way a deletion can *look* undone: a
 * `.hivemem/project.json` left in the directory re-registers the same project
 * id the next time that path is referenced. It is only honoured when the hub
 * can actually see the directory AND the marker still points at this project
 * (a moved/renamed directory may legitimately carry a different id).
 */
export function deleteProject(
  db: Db,
  id: string,
  options?: { removeMarker?: boolean; actor?: string | null },
): DeleteProjectResult {
  const row = getProject(db, id);
  if (!row) {
    throw new HiveMemError('PROJECT_NOT_FOUND', `项目 ${id} 不存在（可能已被删除）。`, {
      hint: '用 GET /api/projects 或管理面板查看当前项目列表。',
    });
  }
  if (row.name.toLowerCase() === USER_PROJECT_NAME) {
    throw new HiveMemError('RESERVED_NAME', '「@user」是保留项目（用户级记忆容器），不可删除。', {
      hint: '如只想清空跨项目记忆，逐条删除其中的记忆即可；该行会按需自动重建。',
    });
  }

  const countOf = (sql: string): number =>
    (db.prepare(sql).get(id) as { n: number }).n;
  const memories = countOf('SELECT COUNT(*) AS n FROM memories WHERE project_id = ?');
  const aliases = countOf('SELECT COUNT(*) AS n FROM project_aliases WHERE project_id = ?');
  const grants = countOf('SELECT COUNT(*) AS n FROM grants WHERE project_id = ?');
  const markerExisted = hasMarker(row.root_path);

  db.exec('BEGIN IMMEDIATE');
  try {
    // Delete memories explicitly rather than relying on the FK cascade alone:
    // an explicit DELETE is guaranteed to fire the external-content FTS
    // delete trigger, so the index can never keep phantom rows.
    db.prepare('DELETE FROM memories WHERE project_id = ?').run(id);
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    db.prepare(
      'INSERT INTO audit_log (ts, project_id, memory_id, action, actor, detail) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      nowIso(),
      id,
      null,
      'project_delete',
      options?.actor ?? null,
      JSON.stringify({ name: row.name, root_path: row.root_path, memories, aliases, grants }),
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  let markerRemoved = false;
  if (options?.removeMarker && markerExisted && row.root_path) {
    const doc = readMarker(row.root_path);
    const file = markerPathOf(row.root_path);
    if (doc && doc.id === id && file) {
      try {
        unlinkSync(file);
        markerRemoved = true;
      } catch {
        /* best effort: the marker may be read-only or locked */
      }
    }
  }

  return {
    id: row.id,
    name: row.name,
    root_path: row.root_path,
    memories,
    aliases,
    grants,
    marker_existed: markerExisted,
    marker_removed: markerRemoved,
  };
}

/**
 * Centralized-hub fallback: the reference is a path on the client's machine,
 * invisible to the hub's filesystem. Resolve it against the registry (path
 * aliases, then root_path) using the client-side normalization. Registration
 * by path is impossible in this mode — unknown paths fall through to the
 * PROJECT_NOT_FOUND error, which lists registered projects.
 */
function findByPathRef(db: Db, ref: string): ProjectRow | null {
  const key = normalizePathRef(ref);
  const alias = db
    .prepare('SELECT project_id FROM project_aliases WHERE alias_path = ?')
    .get(key) as { project_id: string } | undefined;
  if (alias) {
    const row = getProject(db, alias.project_id);
    if (row) return row;
  }
  const byRoot = db
    .prepare('SELECT id FROM projects WHERE root_path = ? ORDER BY created_at')
    .all(key) as Array<{ id: string }>;
  if (byRoot.length === 1) return getProject(db, byRoot[0].id);
  return null;
}

function listError(db: Db, accessibleIds?: Set<string>): HiveMemError {
  const all = db
    .prepare('SELECT id, name, root_path, owner_user_id FROM projects ORDER BY name')
    .all() as Array<{ id: string; name: string; root_path: string | null; owner_user_id: string | null }>;
  // Non-admin users must not learn other users' project names from the hint.
  const projects = accessibleIds ? all.filter((p) => accessibleIds.has(p.id)) : all;
  return new HiveMemError('PROJECT_NOT_FOUND', '未找到该项目。请传入项目名、项目 id 或已注册项目的工作区根目录路径。', {
    hint: '已注册项目见 detail.projects：改用项目名重试（项目名通常与工作区目录名一致）。新项目：以新项目名调用一次 memory_bootstrap 即可自动创建（或经管理面板/REST API 创建）。',
    detail: { projects },
  });
}

export interface ResolveOptions {
  cwd?: string;
  mode: 'read' | 'write';
  /** Requesting user id (multi-user mode); null/undefined = legacy single-user. */
  ownerId?: string | null;
  /** Platform admins resolve names globally and see every project in hints. */
  admin?: boolean;
  /** Accessible project ids (owned + granted) used to filter the error hint. */
  accessibleIds?: Set<string>;
}

/**
 * Resolve a project reference. Names are the primary reference for agents:
 *
 * Order: explicit id → project name (case-insensitive; owner-scoped for
 * non-admin users in multi-user mode, global for admins and legacy mode;
 * duplicates within a scope are a hard ambiguity error, never a silent pick)
 * → path-shaped reference: if the path exists on the hub's own filesystem
 * (stdio mode, hub on the client machine) it registers via marker walk-up;
 * otherwise it is matched against registered aliases/root_path with the
 * client-side normalization (centralized hub — the client's filesystem is
 * invisible, so registration by path is impossible and unknown paths error).
 * With no reference, the marker is searched upward from `cwd`; `mode: 'write'`
 * backfills a marker file so the identity sticks, `mode: 'read'` only
 * registers a row keyed by path.
 */
export function resolveProject(
  db: Db,
  ref: string | undefined,
  options: ResolveOptions,
): ProjectRow {
  const cwd = options.cwd ?? process.cwd();
  const withMarker = options.mode === 'write';
  const ownerId = options.ownerId ?? null;

  if (!ref || !ref.trim()) {
    const root = findProjectRoot(cwd);
    return ensureProject(db, root ?? cwd, { withMarker, ownerUserId: ownerId });
  }

  const trimmed = ref.trim();
  if (trimmed.toLowerCase() === USER_PROJECT_NAME) return ensureUserProject(db, ownerId);

  const byId = getProject(db, trimmed);
  if (byId) return byId;

  const nameScan = (ownerSql: string, ...ownerParams: (string | null)[]) =>
    db
      .prepare(`SELECT id FROM projects WHERE lower(name) = lower(?) AND ${ownerSql} ORDER BY created_at`)
      .all(trimmed, ...ownerParams) as Array<{ id: string }>;
  let nameMatches: Array<{ id: string }>;
  if (options.admin || !ownerId) {
    // Admins and legacy mode resolve names globally.
    nameMatches = db
      .prepare('SELECT id FROM projects WHERE lower(name) = lower(?) ORDER BY created_at')
      .all(trimmed) as Array<{ id: string }>;
  } else {
    // Non-admin users: their own projects first, then unowned legacy rows.
    nameMatches = nameScan('owner_user_id = ?', ownerId);
    if (nameMatches.length === 0) nameMatches = nameScan('owner_user_id IS NULL');
  }
  if (nameMatches.length === 1) {
    const row = getProject(db, nameMatches[0].id);
    if (row) return row;
  }
  if (nameMatches.length > 1) {
    const candidates = nameMatches.map((m) => {
      const row = getProject(db, m.id);
      return { id: m.id, name: row?.name, root_path: row?.root_path };
    });
    throw new HiveMemError(
      'AMBIGUOUS_PROJECT',
      `项目名 "${trimmed}" 不唯一（${nameMatches.length} 个同名项目），名称引用无法解析。`,
      {
        hint: '改用项目 id（prj_ 开头）引用其中一个；或用管理平台给它们改成不同的名字。',
        detail: { candidates },
      },
    );
  }

  // Only path-shaped references may resolve as filesystem references.
  // Arbitrary strings (typos, guesses) must NOT walk up from the hub's own
  // working directory — that would silently resolve to an unrelated project.
  if (isPathRef(trimmed)) {
    if (existsSync(trimmed)) {
      // Local filesystem (stdio mode, or a hub running on the client machine):
      // marker walk-up and registration work as before.
      return ensureProject(db, findProjectRoot(trimmed) ?? trimmed, { withMarker, ownerUserId: ownerId });
    }
    // Centralized hub: the path lives on the client's machine and is invisible
    // here. Match it against registered aliases/root paths instead — never
    // walk up from (or register against) the hub's own filesystem.
    const registered = findByPathRef(db, trimmed);
    if (registered) return registered;
  }

  throw listError(db, options.admin ? undefined : options.accessibleIds);
}
