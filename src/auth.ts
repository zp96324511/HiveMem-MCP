/**
 * Multi-user authentication and project-granular authorization (DESIGN.md §13.3).
 *
 * Credential separation: MCP clients authenticate with per-user Bearer tokens
 * (stored as SHA-256 hashes — the tokens are high-entropy random values, so a
 * plain hash is sufficient); humans log into the web panel with username +
 * scrypt password and receive a session cookie (also stored hashed). Grants
 * are project-granular: row-level grants would force per-row permission
 * filtering after hybrid retrieval scoring, which explodes in complexity.
 *
 * Legacy compatibility: while the users table is empty the hub stays in
 * single-user mode — the env token (if any) keeps working and everything is
 * open exactly as before. Creating the first user opts into multi-user mode:
 * it becomes the platform admin and claims all unowned projects.
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Db } from './db.js';
import { HiveMemError, newSessionId, newTokenId, newUserId, nowIso } from './util.js';

export type Role = 'user' | 'admin';

export interface UserRow {
  id: string;
  name: string;
  password_hash: string;
  role: Role;
  created_at: string;
  updated_at: string;
}

export interface AuthContext {
  /** null in legacy single-user mode (users table still empty). */
  userId: string | null;
  name: string | null;
  role: Role;
  /** How this request authenticated. */
  via: 'legacy' | 'token' | 'session';
}

/** Legacy single-user context: full access, no isolation. */
export const LEGACY_AUTH: AuthContext = { userId: null, name: null, role: 'admin', via: 'legacy' };

type Row = Record<string, unknown>;

const toUser = (r: Row): UserRow => ({
  id: String(r.id),
  name: String(r.name),
  password_hash: String(r.password_hash),
  role: r.role as Role,
  created_at: String(r.created_at),
  updated_at: String(r.updated_at),
});

// ---------------------------------------------------------------------------
// Password hashing (scrypt) and token hashing (SHA-256)
// ---------------------------------------------------------------------------

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${key.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4], 'hex');
  const expected = Buffer.from(parts[5], 'hex');
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p) || !salt.length || !expected.length) {
    return false;
  }
  const key = scryptSync(password, salt, expected.length, { N: n, r, p });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** High-entropy random tokens → plain SHA-256 is sufficient (no salt needed). */
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export function userCount(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
}

export function getUserByName(db: Db, name: string): UserRow | null {
  const row = db
    .prepare('SELECT * FROM users WHERE lower(name) = lower(?)')
    .get(name.trim()) as Row | undefined;
  return row ? toUser(row) : null;
}

export function getUserById(db: Db, id: string): UserRow | null {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Row | undefined;
  return row ? toUser(row) : null;
}

/** User list without password hashes (admin panel). */
export function listUsers(db: Db): Array<{ id: string; name: string; role: Role; created_at: string; updated_at: string }> {
  return db
    .prepare('SELECT id, name, role, created_at, updated_at FROM users ORDER BY name')
    .all() as unknown as Array<{ id: string; name: string; role: Role; created_at: string; updated_at: string }>;
}

export interface CreateUserInput {
  name: string;
  password: string;
  /** Ignored (forced to admin) when this is the first user. */
  role?: Role;
  /** Optional existing plaintext token (e.g. HIVEMEM_TOKEN) to adopt as this user's MCP token. */
  adoptToken?: string;
}

/**
 * Create a user. The FIRST user is always the platform admin and claims every
 * previously unowned project (the opt-in moment for multi-user mode).
 */
export function createUser(db: Db, input: CreateUserInput): { user: UserRow; token: string | null } {
  const name = input.name.trim();
  if (!name) throw new HiveMemError('INVALID_INPUT', '用户名不能为空');
  if (input.password.length < 6) {
    throw new HiveMemError('INVALID_INPUT', '密码至少 6 位');
  }
  if (getUserByName(db, name)) {
    throw new HiveMemError('USER_EXISTS', `用户名 "${name}" 已存在`);
  }
  const first = userCount(db) === 0;
  const role: Role = first ? 'admin' : (input.role ?? 'user');
  const id = newUserId();
  const now = nowIso();
  db.prepare(
    'INSERT INTO users (id, name, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, name, hashPassword(input.password), role, now, now);
  if (first) {
    // Claim all legacy projects (including the legacy '@user' row).
    db.prepare('UPDATE projects SET owner_user_id = ? WHERE owner_user_id IS NULL').run(id);
  }
  const user = getUserById(db, id);
  if (!user) throw new HiveMemError('DB_ERROR', '用户创建后读取失败');
  let token: string | null = null;
  if (input.adoptToken?.trim()) {
    token = adoptToken(db, id, input.adoptToken).token;
  }
  return { user, token };
}

export function setUserPassword(db: Db, userId: string, password: string): void {
  if (password.length < 6) throw new HiveMemError('INVALID_INPUT', '密码至少 6 位');
  const user = getUserById(db, userId);
  if (!user) throw new HiveMemError('USER_NOT_FOUND', `用户 ${userId} 不存在`);
  db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
    hashPassword(password),
    nowIso(),
    userId,
  );
  // Password change invalidates all web sessions of that user.
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function setUserRole(db: Db, userId: string, role: Role): void {
  const user = getUserById(db, userId);
  if (!user) throw new HiveMemError('USER_NOT_FOUND', `用户 ${userId} 不存在`);
  if (user.role === 'admin' && role !== 'admin') {
    const admins = (
      db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as { n: number }
    ).n;
    if (admins <= 1) {
      throw new HiveMemError('LAST_ADMIN', '不能降级最后一个管理员');
    }
  }
  db.prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?').run(role, nowIso(), userId);
}

export function deleteUser(db: Db, userId: string): void {
  const user = getUserById(db, userId);
  if (!user) throw new HiveMemError('USER_NOT_FOUND', `用户 ${userId} 不存在`);
  if (user.role === 'admin') {
    const admins = (
      db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as { n: number }
    ).n;
    if (admins <= 1) {
      throw new HiveMemError('LAST_ADMIN', '不能删除最后一个管理员');
    }
  }
  // Owned projects become unowned (admin can reassign later); tokens,
  // sessions and grants cascade via foreign keys.
  db.prepare('UPDATE projects SET owner_user_id = NULL WHERE owner_user_id = ?').run(userId);
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
}

// ---------------------------------------------------------------------------
// MCP tokens
// ---------------------------------------------------------------------------

/** Generate a new MCP token for a user; the plaintext is returned exactly once. */
export function createToken(db: Db, userId: string, name = 'default'): { id: string; token: string } {
  const user = getUserById(db, userId);
  if (!user) throw new HiveMemError('USER_NOT_FOUND', `用户 ${userId} 不存在`);
  const token = randomBytes(32).toString('hex');
  const id = newTokenId();
  db.prepare(
    'INSERT INTO tokens (id, user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, userId, name, hashToken(token), nowIso());
  return { id, token };
}

export function listTokens(
  db: Db,
  userId?: string,
): Array<{ id: string; user_id: string; name: string; created_at: string; last_used_at: string | null; revoked_at: string | null }> {
  return userId
    ? (db
        .prepare('SELECT id, user_id, name, created_at, last_used_at, revoked_at FROM tokens WHERE user_id = ? ORDER BY created_at DESC')
        .all(userId) as unknown as Array<{ id: string; user_id: string; name: string; created_at: string; last_used_at: string | null; revoked_at: string | null }>)
    : (db
        .prepare('SELECT id, user_id, name, created_at, last_used_at, revoked_at FROM tokens ORDER BY created_at DESC')
        .all() as unknown as Array<{ id: string; user_id: string; name: string; created_at: string; last_used_at: string | null; revoked_at: string | null }>);
}

export function revokeToken(db: Db, tokenId: string): void {
  db.prepare('UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(nowIso(), tokenId);
}

/** Register an existing plaintext token (e.g. the legacy env token) for a user. */
export function adoptToken(db: Db, userId: string, plaintext: string, name = 'adopted'): { id: string; token: string } {
  const user = getUserById(db, userId);
  if (!user) throw new HiveMemError('USER_NOT_FOUND', `用户 ${userId} 不存在`);
  const id = newTokenId();
  db.prepare(
    'INSERT INTO tokens (id, user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, userId, name, hashToken(plaintext.trim()), nowIso());
  return { id, token: plaintext.trim() };
}

// ---------------------------------------------------------------------------
// Web sessions
// ---------------------------------------------------------------------------

const SESSION_TTL_MS = 30 * 86_400_000;

export function createSession(db: Db, userId: string): { token: string; expiresAt: string } {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare(
    'INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
  ).run(newSessionId(), userId, hashToken(token), nowIso(), expiresAt);
  return { token, expiresAt };
}

export function authenticateSession(db: Db, sessionToken: string | undefined): AuthContext | null {
  if (!sessionToken) return null;
  // Lazy purge of expired sessions.
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(nowIso());
  const row = db
    .prepare(
      `SELECT s.id, s.user_id, u.name, u.role FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(hashToken(sessionToken), nowIso()) as Row | undefined;
  if (!row) return null;
  return { userId: String(row.user_id), name: String(row.name), role: row.role as Role, via: 'session' };
}

export function deleteSession(db: Db, sessionToken: string): void {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(sessionToken));
}

// ---------------------------------------------------------------------------
// Bearer authentication (MCP + REST)
// ---------------------------------------------------------------------------

const bearerValue = (authorization: string | undefined): string | null => {
  if (!authorization?.startsWith('Bearer ')) return null;
  const raw = authorization.slice('Bearer '.length).trim();
  return raw || null;
};

/**
 * Authenticate a Bearer request.
 *
 * - Multi-user mode (users exist): the token is looked up by SHA-256 hash in
 *   the tokens table; revocation takes effect immediately.
 * - Legacy single-user mode: the env token gates access exactly as before
 *   (timing-safe); no env token means an open localhost hub.
 */
export function authenticateBearer(
  db: Db,
  authorization: string | undefined,
  envToken: string | undefined,
): AuthContext | null {
  if (userCount(db) === 0) {
    if (!envToken) return LEGACY_AUTH;
    const raw = bearerValue(authorization);
    if (raw === null || raw.length !== envToken.length) return null;
    return timingSafeEqual(Buffer.from(raw), Buffer.from(envToken)) ? LEGACY_AUTH : null;
  }
  const raw = bearerValue(authorization);
  if (raw === null) return null;
  const row = db
    .prepare(
      `SELECT t.id, t.user_id, u.name, u.role FROM tokens t
         JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = ? AND t.revoked_at IS NULL`,
    )
    .get(hashToken(raw)) as Row | undefined;
  if (!row) return null;
  db.prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?').run(nowIso(), String(row.id));
  return { userId: String(row.user_id), name: String(row.name), role: row.role as Role, via: 'token' };
}

// ---------------------------------------------------------------------------
// Grants (project-granular read-only authorization)
// ---------------------------------------------------------------------------

export interface GrantRow {
  id: number;
  grantor_user_id: string;
  grantee_user_id: string;
  project_id: string;
  created_at: string;
  revoked_at: string | null;
}

export function hasActiveGrant(db: Db, userId: string, projectId: string): boolean {
  return (
    db
      .prepare(
        'SELECT 1 AS x FROM grants WHERE grantee_user_id = ? AND project_id = ? AND revoked_at IS NULL LIMIT 1',
      )
      .get(userId, projectId) !== undefined
  );
}

export function grantAccess(
  db: Db,
  input: { grantorUserId: string; granteeUserId: string; projectId: string },
): GrantRow {
  const grantee = getUserById(db, input.granteeUserId);
  if (!grantee) throw new HiveMemError('USER_NOT_FOUND', `被授权用户 ${input.granteeUserId} 不存在`);
  const project = db
    .prepare('SELECT id, owner_user_id, name FROM projects WHERE id = ?')
    .get(input.projectId) as { id: string; owner_user_id: string | null; name: string } | undefined;
  if (!project) throw new HiveMemError('PROJECT_NOT_FOUND', `项目 ${input.projectId} 不存在`);
  if (project.owner_user_id === grantee.id) {
    throw new HiveMemError('GRANT_POINTLESS', '项目所有者无需授权');
  }
  const existing = db
    .prepare('SELECT * FROM grants WHERE grantee_user_id = ? AND project_id = ? AND revoked_at IS NULL')
    .get(input.granteeUserId, input.projectId) as Row | undefined;
  if (existing) return existing as unknown as GrantRow;
  db.prepare(
    'INSERT INTO grants (grantor_user_id, grantee_user_id, project_id, created_at) VALUES (?, ?, ?, ?)',
  ).run(input.grantorUserId, input.granteeUserId, input.projectId, nowIso());
  const row = db
    .prepare('SELECT * FROM grants WHERE grantee_user_id = ? AND project_id = ? AND revoked_at IS NULL')
    .get(input.granteeUserId, input.projectId) as Row | undefined;
  if (!row) throw new HiveMemError('DB_ERROR', '授权后读取失败');
  return row as unknown as GrantRow;
}

export function revokeGrant(db: Db, grantId: number): void {
  db.prepare('UPDATE grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(nowIso(), grantId);
}

export function listGrants(
  db: Db,
  options?: { granteeUserId?: string; includeRevoked?: boolean },
): Array<GrantRow & { grantee_name: string; project_name: string }> {
  const conds: string[] = [];
  const params: (string | number)[] = [];
  if (!options?.includeRevoked) conds.push('g.revoked_at IS NULL');
  if (options?.granteeUserId) {
    conds.push('g.grantee_user_id = ?');
    params.push(options.granteeUserId);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  return db
    .prepare(
      `SELECT g.*, u.name AS grantee_name, p.name AS project_name
         FROM grants g
         JOIN users u ON u.id = g.grantee_user_id
         JOIN projects p ON p.id = g.project_id
        ${where} ORDER BY g.id DESC`,
    )
    .all(...params) as unknown as Array<GrantRow & { grantee_name: string; project_name: string }>;
}

/** Project ids a non-admin user can see in hints/lists: owned + granted. */
export function accessibleProjectIds(db: Db, userId: string): Set<string> {
  const owned = db.prepare('SELECT id FROM projects WHERE owner_user_id = ?').all(userId) as Array<{
    id: string;
  }>;
  const granted = db.prepare(
    'SELECT project_id FROM grants WHERE grantee_user_id = ? AND revoked_at IS NULL',
  ).all(userId) as Array<{ project_id: string }>;
  return new Set([...owned.map((r) => r.id), ...granted.map((r) => r.project_id)]);
}

// ---------------------------------------------------------------------------
// Access check
// ---------------------------------------------------------------------------

/**
 * Project access check. Admins (and legacy single-user mode) pass everything;
 * owners pass read+write; grantees pass read only. Revocation is immediate
 * because this runs per request.
 */
export function assertProjectAccess(
  db: Db,
  auth: AuthContext,
  project: { id: string; owner_user_id: string | null },
  mode: 'read' | 'write',
): void {
  if (auth.role === 'admin' || auth.userId === null) return;
  if (project.owner_user_id === auth.userId) return;
  if (mode === 'read' && hasActiveGrant(db, auth.userId, project.id)) return;
  throw new HiveMemError(
    'FORBIDDEN',
    mode === 'write'
      ? `无权写入项目（仅所有者与管理员可写；当前用户 ${auth.name ?? auth.userId}）`
      : `无权读取项目（需所有者、管理员或有效只读授权；当前用户 ${auth.name ?? auth.userId}）`,
    { hint: '可请平台管理员通过授权管理开放只读权限。' },
  );
}
