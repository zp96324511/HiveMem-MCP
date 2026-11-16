import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { defaultDbPath, openDb, type Db } from './db.js';
import type { Embedder } from './embedding.js';
import * as auth from './auth.js';
import { createMcpServer } from './mcp.js';
import {
  createNamedProject,
  deleteProject,
  ensureProject,
  ensureUserProject,
  hasMarker,
  resolveProject,
  USER_PROJECT_ID,
  USER_PROJECT_NAME,
} from './projects.js';
import { listDevices, normalizeScopeName, registerDevice, resolveDevice, tagsForScope, type Scope, type ScopeContext } from './scope.js';
import * as store from './store.js';
import { nowIso, HiveMemError } from './util.js';
import * as vec from './vec.js';

export interface HubOptions {
  /** Opened externally when provided (tests own the lifecycle); otherwise opened from dbPath. */
  db?: Db;
  dbPath?: string;
  port: number;
  host?: string;
  /** When set, /mcp and /api require `Authorization: Bearer <token>`. */
  token?: string;
  /** Optional embedder enabling semantic search. */
  embedder?: Embedder | null;
}

/** Constant-time bearer check; absent token means auth disabled. */
export function verifyToken(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  const received = Buffer.from(req.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function webAssetPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, 'web', 'index.html'),
    path.join(here, '..', 'web', 'index.html'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('web UI asset not found (expected dist/web/index.html or web/index.html)');
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const parsed = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        resolve(typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const strArray = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;

async function handleApi(
  db: Db,
  embedder: Embedder | null | undefined,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  scopeCtx: ScopeContext,
  authCtx: auth.AuthContext,
): Promise<void> {
  const segments = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const resource = segments[1];
  const method = req.method ?? 'GET';
  const requireAdmin = (): boolean => {
    if (authCtx.role === 'admin') return true;
    sendJson(res, 403, { error: '仅平台管理员可执行此操作' });
    return false;
  };
  /** Resolve a project reference and enforce access for this request. */
  const resolveChecked = (ref: string | undefined, mode: 'read' | 'write') => {
    const project = resolveProject(db, ref, {
      mode,
      ownerId: authCtx.userId,
      admin: authCtx.role === 'admin',
      accessibleIds: authCtx.userId ? auth.accessibleProjectIds(db, authCtx.userId) : undefined,
    });
    auth.assertProjectAccess(db, authCtx, project, mode);
    return project;
  };
  const intParam = (name: string, fallback: number): number => {
    const raw = url.searchParams.get(name);
    if (raw === null || raw === '') return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  try {
    // ---- auth (login is reachable without a session by design) -----------
    if (resource === 'auth' && segments[2] === 'login' && method === 'POST') {
      const body = await readJsonBody(req);
      const name = str(body.name);
      const password = typeof body.password === 'string' ? body.password : '';
      if (!name || !password) return sendJson(res, 400, { error: 'name and password are required' });
      const user = auth.getUserByName(db, name);
      if (!user || !auth.verifyPassword(password, user.password_hash)) {
        return sendJson(res, 401, { error: '用户名或密码错误' });
      }
      const session = auth.createSession(db, user.id);
      res.setHeader(
        'Set-Cookie',
        `hivemem_session=${session.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}`,
      );
      return sendJson(res, 200, { user: { id: user.id, name: user.name, role: user.role } });
    }
    if (resource === 'auth' && segments[2] === 'logout' && method === 'POST') {
      const raw = parseSessionCookie(req.headers.cookie);
      if (raw) auth.deleteSession(db, raw);
      res.setHeader('Set-Cookie', 'hivemem_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
      return sendJson(res, 200, { ok: true });
    }
    if (resource === 'auth' && segments[2] === 'me' && method === 'GET') {
      return sendJson(res, 200, {
        user: authCtx.userId ? { id: authCtx.userId, name: authCtx.name, role: authCtx.role } : null,
        via: authCtx.via,
        multiUser: auth.userCount(db) > 0,
      });
    }

    // ---- users & tokens (admin) -------------------------------------------
    if (resource === 'users') {
      if (!requireAdmin()) return;
      if (segments.length === 2 && method === 'GET') {
        return sendJson(res, 200, { users: auth.listUsers(db) });
      }
      if (segments.length === 2 && method === 'POST') {
        const body = await readJsonBody(req);
        const name = str(body.name);
        const password = typeof body.password === 'string' ? body.password : '';
        if (!name || !password) return sendJson(res, 400, { error: 'name and password are required' });
        try {
          const { user } = auth.createUser(db, {
            name,
            password,
            role: str(body.role) === 'admin' ? 'admin' : 'user',
          });
          return sendJson(res, 201, { user: { id: user.id, name: user.name, role: user.role } });
        } catch (error) {
          return sendJson(res, 409, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (segments.length === 4 && segments[3] === 'tokens') {
        const userId = segments[2];
        if (method === 'GET') return sendJson(res, 200, { tokens: auth.listTokens(db, userId) });
        if (method === 'POST') {
          const body = await readJsonBody(req);
          try {
            const created = auth.createToken(db, userId, str(body.name) ?? 'default');
            // The plaintext token is returned exactly once.
            return sendJson(res, 201, created);
          } catch (error) {
            return sendJson(res, 404, { error: error instanceof Error ? error.message : String(error) });
          }
        }
      }
      if (segments.length === 3 && method === 'PATCH') {
        const body = await readJsonBody(req);
        const password = typeof body.password === 'string' ? body.password : undefined;
        const role = str(body.role) === 'admin' ? 'admin' : str(body.role) === 'user' ? 'user' : undefined;
        try {
          if (password !== undefined) auth.setUserPassword(db, segments[2], password);
          if (role !== undefined) auth.setUserRole(db, segments[2], role);
        } catch (error) {
          return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
        const user = auth.getUserById(db, segments[2]);
        return sendJson(res, 200, { user: user ? { id: user.id, name: user.name, role: user.role } : null });
      }
      if (segments.length === 3 && method === 'DELETE') {
        try {
          auth.deleteUser(db, segments[2]);
        } catch (error) {
          return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
        return sendJson(res, 200, { deleted: true });
      }
    }
    if (resource === 'tokens' && segments.length === 3 && method === 'DELETE') {
      if (!requireAdmin()) return;
      auth.revokeToken(db, segments[2]);
      return sendJson(res, 200, { revoked: true });
    }

    // ---- grants (admin) ----------------------------------------------------
    if (resource === 'grants') {
      if (!requireAdmin()) return;
      if (method === 'GET') {
        const userParam = url.searchParams.get('user') ?? undefined;
        return sendJson(res, 200, { grants: auth.listGrants(db, { granteeUserId: userParam }) });
      }
      if (method === 'POST') {
        const body = await readJsonBody(req);
        const granteeId = str(body.grantee_user_id);
        const granteeName = str(body.grantee_name);
        const grantee = granteeId
          ? auth.getUserById(db, granteeId)
          : granteeName
            ? auth.getUserByName(db, granteeName)
            : null;
        if (!grantee) return sendJson(res, 400, { error: 'grantee_user_id 或 grantee_name 必填且须存在' });
        const projectRef = str(body.project_id) ?? str(body.project);
        if (!projectRef) return sendJson(res, 400, { error: 'project_id 或 project 必填' });
        try {
          const project = resolveProject(db, projectRef, { mode: 'read', admin: true });
          const grant = auth.grantAccess(db, {
            grantorUserId: authCtx.userId ?? 'system',
            granteeUserId: grantee.id,
            projectId: project.id,
          });
          return sendJson(res, 201, { grant: { ...grant, grantee_name: grantee.name, project_name: project.name } });
        } catch (error) {
          return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (segments.length === 3 && method === 'DELETE') {
        auth.revokeGrant(db, Number(segments[2]));
        return sendJson(res, 200, { revoked: true });
      }
    }

    // ---- projects -------------------------------------------------------
    if (resource === 'projects') {
      if (method === 'GET') {
        const rows = db
          .prepare(
            `SELECT p.id, p.name, p.root_path, p.owner_user_id, p.created_at, p.updated_at,
               (SELECT COUNT(*) FROM memories m WHERE m.project_id = p.id AND m.status = 'active') AS active_count,
               (SELECT MAX(m.updated_at) FROM memories m WHERE m.project_id = p.id) AS last_memory_at
             FROM projects p ORDER BY p.name`,
          )
          .all() as Array<{
          id: string;
          name: string;
          root_path: string | null;
          owner_user_id: string | null;
          active_count: number;
          last_memory_at: string | null;
        }>;
        // Non-admin users only see their own and granted projects.
        const viewerId = authCtx.userId;
        const visible =
          viewerId && authCtx.role !== 'admin'
            ? rows.filter((p) => p.owner_user_id === viewerId || auth.hasActiveGrant(db, viewerId, p.id))
            : rows;
        // marker_exists tells the panel whether deleting also has to remove a
        // marker file — only knowable when the directory is on the hub's host.
        return sendJson(res, 200, {
          projects: visible.map((p) => ({ ...p, marker_exists: hasMarker(p.root_path) })),
        });
      }
      if (method === 'POST') {
        const body = await readJsonBody(req);
        const name = str(body.name);
        if (!name) return sendJson(res, 400, { error: 'name is required' });
        const rootPath = str(body.root_path);
        if (rootPath && existsSync(rootPath)) {
          const row = ensureProject(db, rootPath, { name, withMarker: false, ownerUserId: authCtx.userId });
          return sendJson(res, 201, { project: row });
        }
        // Manual creation (no directory): a taken name is a hard conflict
        // (unlike path-derived registration, which auto-suffixes).
        try {
          const row = createNamedProject(db, { name, ownerUserId: authCtx.userId });
          return sendJson(res, 201, { project: row });
        } catch (error) {
          if (error instanceof HiveMemError && (error.code === 'PROJECT_EXISTS' || error.code === 'RESERVED_NAME')) {
            return sendJson(res, 409, { error: error.message, ...(error.detail ?? {}) });
          }
          throw error;
        }
      }
      if (segments.length === 3 && method === 'PATCH') {
        // Rename a project (fix auto-suffixed or legacy names; keeps names unique).
        const id = segments[2];
        const body = await readJsonBody(req);
        const name = str(body.name);
        if (!name) return sendJson(res, 400, { error: 'name is required' });
        if (name.toLowerCase() === USER_PROJECT_NAME) {
          return sendJson(res, 409, { error: '"@user" 是保留项目名（用户级记忆），不能改用' });
        }
        const row = db
          .prepare('SELECT id, name, root_path, owner_user_id FROM projects WHERE id = ?')
          .get(id) as { id: string; name: string; root_path: string | null; owner_user_id: string | null } | undefined;
        if (!row) return sendJson(res, 404, { error: 'not found' });
        if (authCtx.role !== 'admin' && row.owner_user_id !== authCtx.userId) {
          return sendJson(res, 403, { error: '仅项目所有者与管理员可重命名' });
        }
        const taken = db
          .prepare('SELECT id FROM projects WHERE lower(name) = lower(?) AND (owner_user_id IS ?) AND id <> ?')
          .get(name, row.owner_user_id, id) as { id: string } | undefined;
        if (taken) {
          return sendJson(res, 409, { error: `项目名 "${name}" 已被 ${taken.id} 使用` });
        }
        db.prepare('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?').run(name, nowIso(), id);
        // Admins can additionally reassign the project owner.
        const ownerUserId = str(body.owner_user_id);
        if (ownerUserId !== undefined) {
          if (authCtx.role !== 'admin') return sendJson(res, 403, { error: '仅管理员可变更项目所有者' });
          if (ownerUserId === '') {
            db.prepare('UPDATE projects SET owner_user_id = NULL WHERE id = ?').run(id);
          } else {
            if (!auth.getUserById(db, ownerUserId)) return sendJson(res, 400, { error: 'owner 用户不存在' });
            db.prepare('UPDATE projects SET owner_user_id = ? WHERE id = ?').run(ownerUserId, id);
          }
        }
        return sendJson(res, 200, {
          project: db
            .prepare('SELECT id, name, root_path, owner_user_id, created_at, updated_at FROM projects WHERE id = ?')
            .get(id),
        });
      }
      if (segments.length === 3 && method === 'DELETE') {
        // Permanently delete a project with all its memories (web platform).
        // The '@user' row is refused: it is the user-level memory container and
        // is recreated on demand, so deleting it only destroys context.
        const id = segments[2];
        const row = db
          .prepare('SELECT id, name, root_path, owner_user_id FROM projects WHERE id = ?')
          .get(id) as { id: string; name: string; root_path: string | null; owner_user_id: string | null } | undefined;
        if (!row) return sendJson(res, 404, { error: 'not found' });
        if (row.name.toLowerCase() === USER_PROJECT_NAME || row.id === USER_PROJECT_ID) {
          return sendJson(res, 409, { error: '「@user」是保留项目（用户级记忆容器），不可删除' });
        }
        if (authCtx.role !== 'admin' && row.owner_user_id !== authCtx.userId) {
          return sendJson(res, 403, { error: '仅项目所有者与管理员可删除项目' });
        }
        const memoryCount = (
          db.prepare('SELECT COUNT(*) AS n FROM memories WHERE project_id = ?').get(id) as { n: number }
        ).n;
        // Confirmation: for a non-empty project the caller must echo its name
        // (query string or JSON body), so no client deletes a cascade by accident.
        let confirm = url.searchParams.get('confirm') ?? undefined;
        let removeMarker = ['1', 'true', 'yes'].includes(
          (url.searchParams.get('remove_marker') ?? '').toLowerCase(),
        );
        if (confirm === undefined || !removeMarker) {
          const body = await readJsonBody(req).catch(() => ({}) as Record<string, unknown>);
          if (confirm === undefined) confirm = str(body.confirm);
          if (!removeMarker) removeMarker = body.remove_marker === true;
        }
        if (memoryCount > 0 && (confirm ?? '').trim().toLowerCase() !== row.name.toLowerCase()) {
          return sendJson(res, 400, {
            error: `删除非空项目需确认：请传入 confirm=${row.name}（项目名）`,
            confirm_required: row.name,
            memories: memoryCount,
          });
        }
        try {
          const result = deleteProject(db, id, { removeMarker, actor: authCtx.name ?? authCtx.userId ?? 'web' });
          return sendJson(res, 200, { deleted: true, ...result });
        } catch (error) {
          if (error instanceof HiveMemError && error.code === 'RESERVED_NAME') {
            return sendJson(res, 409, { error: error.message, ...(error.detail ?? {}) });
          }
          throw error;
        }
      }
    }

    // ---- memories -------------------------------------------------------
    if (resource === 'memories') {
      if (segments.length === 2) {
        if (method === 'GET') {
          const projectRef = url.searchParams.get('project') ?? undefined;
          const projectId = projectRef ? resolveChecked(projectRef, 'read').id : undefined;
          // Absent status defaults to active (MCP parity); empty string means all statuses.
          const statusRaw = url.searchParams.get('status');
          const status: store.Status | undefined =
            statusRaw === null ? 'active' : statusRaw === '' ? undefined : (statusRaw as store.Status);
          const kindParam = url.searchParams.get('kind') ?? undefined;
          const tag = url.searchParams.get('tag');
          // User-level memories participate in every project's retrieval (MCP parity);
          // global searches of non-admin users stay inside their accessible set.
          let projectIds: string[] | undefined;
          if (projectId !== undefined) {
            const userProjectId = ensureUserProject(db, authCtx.userId).id;
            projectIds = projectId === userProjectId ? [projectId] : [projectId, userProjectId];
          } else if (authCtx.userId && authCtx.role !== 'admin') {
            projectIds = [...auth.accessibleProjectIds(db, authCtx.userId)];
          }
          const result = await vec.hybridSearch(db, embedder, {
            projectIds,
            scope: (url.searchParams.get('scope') as Scope | null) ?? undefined,
            query: url.searchParams.get('query') ?? undefined,
            kind: (kindParam as store.Kind | null) ?? undefined,
            status,
            tags: tag ? [tag] : undefined,
            // Exact tag filters for tree navigation: present-but-empty means
            // "tag IS NULL" (e.g. device layer = device set, agent null).
            device: url.searchParams.has('device') ? (url.searchParams.get('device') ?? '') : undefined,
            agent: url.searchParams.has('agent') ? (url.searchParams.get('agent') ?? '') : undefined,
            limit: intParam('limit', 50),
            offset: intParam('offset', 0),
          });
          return sendJson(res, 200, result);
        }
        if (method === 'POST') {
          const body = await readJsonBody(req);
          const projectRef = str(body.project);
          const scope = (str(body.scope) as Scope | undefined) ?? 'project';
          if (!projectRef && scope !== 'user') return sendJson(res, 400, { error: 'project is required' });
          const project =
            scope === 'user' ? ensureUserProject(db, authCtx.userId) : resolveChecked(projectRef, 'write');
          if (scope === 'user') auth.assertProjectAccess(db, authCtx, project, 'write');
          // Never silently degrade: an agent-scoped write needs an agent identity.
          if (scope === 'agent' && !scopeCtx.agent && !str(body.agent)) {
            return sendJson(res, 400, { error: 'scope=agent 需要 X-HiveMem-Agent 头或显式 agent 字段标识工具身份' });
          }
          // Explicit device/agent fields (web tree writes) override the
          // request-context tags, so the panel can manage other devices'
          // memories; absent fields keep the context-driven behavior. An
          // empty string means "explicitly NULL" (all-devices agent rows).
          const scopeTags = tagsForScope(scope, scopeCtx);
          const explicitDevice = body.device === undefined ? undefined : normalizeScopeName(String(body.device));
          const explicitAgent = body.agent === undefined ? undefined : normalizeScopeName(String(body.agent));
          const deviceTag =
            scope === 'device' || scope === 'agent'
              ? explicitDevice !== undefined
                ? explicitDevice
                : scopeTags.device
              : scopeTags.device;
          const agentTag = scope === 'agent' ? (explicitAgent !== undefined ? explicitAgent : scopeTags.agent) : scopeTags.agent;
          const title = str(body.title);
          const content = str(body.content);
          const kind = str(body.kind) as store.Kind | undefined;
          if (!title || !content || !kind) {
            return sendJson(res, 400, { error: 'title, content and kind are required' });
          }
          const memory = store.writeMemory(db, {
            projectId: project.id,
            title,
            content,
            kind,
            tags: strArray(body.tags),
            importance: num(body.importance),
            pinned: bool(body.pinned),
            ttlDays: num(body.ttl_days),
            expiresAt: str(body.expires_at),
            supersedes: str(body.supersedes),
            topicKey: str(body.topic_key),
            sourceAgent: 'web',
            device: deviceTag,
            agent: agentTag,
            evidence: body.evidence as store.Evidence[] | undefined,
          });
          await vec.embedMemoryBestEffort(db, embedder, memory);
          return sendJson(res, 201, { memory });
        }
      }
      if (segments.length === 4 && segments[3] === 'revisions' && method === 'GET') {
        // Version history for one memory: which versions exist, who changed them
        // and what the title was, so a specific snapshot can be requested next.
        const id = segments[2];
        const memory = store.getMemory(db, id);
        if (!memory) return sendJson(res, 404, { error: 'not found' });
        return sendJson(res, 200, {
          memory_id: id,
          current_version: memory.version,
          revisions: store.listRevisions(db, id, 200),
        });
      }
      if (segments.length === 3) {
        const id = segments[2];
        if (method === 'GET') {
          const memory = store.getMemory(db, id, { touch: true });
          if (!memory) return sendJson(res, 404, { error: 'not found' });
          // Historical snapshot: ?at_version=N serves the row as it was then.
          const atRaw = url.searchParams.get('at_version');
          let view = memory;
          let atVersion: number | undefined;
          if (atRaw !== null && atRaw !== '') {
            const n = Number(atRaw);
            const snapshot = store.readMemoryAt(db, id, n);
            if (!snapshot) {
              const known = [...store.listRevisions(db, id, 200).map((r) => r.version), memory.version].sort(
                (a, b) => a - b,
              );
              throw new HiveMemError(
                'REVISION_NOT_FOUND',
                `记忆 ${id} 没有版本 ${atRaw} 的快照（可寻址版本：${known.join(', ')}）`,
                { hint: '版本 1 需先发生一次修改才可寻址；用 ?history=1 或 /revisions 查看全部版本。' },
              );
            }
            view = snapshot;
            atVersion = n;
          }
          const inChain = Boolean(memory.supersedes) || store.hasSuccessors(db, memory.project_id, id);
          const chain = inChain ? store.supersedeChain(db, memory.project_id, id) : undefined;
          const history = ['1', 'true', 'yes'].includes(
            (url.searchParams.get('history') ?? '').toLowerCase(),
          )
            ? { current_version: memory.version, revisions: store.listRevisions(db, id, 200) }
            : undefined;
          return sendJson(res, 200, {
            memory: view,
            ...(atVersion !== undefined ? { at_version: atVersion, live_version: memory.version } : {}),
            ...(chain ? { chain } : {}),
            ...(history ? { history } : {}),
          });
        }
        if (method === 'PATCH') {
          const memory = store.getMemory(db, id);
          if (!memory) return sendJson(res, 404, { error: 'not found' });
          const body = await readJsonBody(req);
          // Optimistic concurrency: an explicit body field wins, else the If-Match
          // header (bare version or a quoted value). This is what makes PATCH safe
          // against a writer that landed between the client's read and this write.
          const ifMatch = Array.isArray(req.headers['if-match'])
            ? req.headers['if-match'][0]
            : req.headers['if-match'];
          const headerVersion = ifMatch
            ? Number(String(ifMatch).trim().replace(/^W\//, '').replaceAll('"', ''))
            : undefined;
          const expectedVersion =
            num(body.expected_version) ?? (Number.isInteger(headerVersion) ? headerVersion : undefined);
          let currentProjectId = memory.project_id;
          const projectRef = str(body.project);
          if (projectRef) {
            const target = resolveChecked(projectRef, 'write');
            if (target.id !== currentProjectId) {
              store.moveMemory(db, id, target.id, 'web');
              currentProjectId = target.id;
            }
          }
          const scope = str(body.scope) as Scope | undefined;
          if (scope === 'agent' && !scopeCtx.agent && !str(body.agent)) {
            return sendJson(res, 400, { error: 'scope=agent 需要 X-HiveMem-Agent 头或显式 agent 字段标识工具身份' });
          }
          // Scope migration: tags come from the request context unless the
          // body carries explicit device/agent values (web tree management);
          // an empty string clears the tag to NULL.
          const scopeTags = scope ? tagsForScope(scope, scopeCtx) : null;
          const explicitDevice = body.device === undefined ? undefined : normalizeScopeName(String(body.device));
          const explicitAgent = body.agent === undefined ? undefined : normalizeScopeName(String(body.agent));
          const deviceTag =
            scope === 'device' || scope === 'agent'
              ? explicitDevice !== undefined
                ? explicitDevice
                : scopeTags!.device
              : scopeTags
                ? scopeTags.device
                : undefined;
          const agentTag =
            scope === 'agent'
              ? explicitAgent !== undefined
                ? explicitAgent
                : scopeTags!.agent
              : scopeTags
                ? scopeTags.agent
                : undefined;
          const updated = store.updateMemory(
            db,
            currentProjectId,
            id,
            {
              title: str(body.title),
              content: str(body.content),
              kind: str(body.kind) as store.Kind | undefined,
              tags: strArray(body.tags),
              importance: num(body.importance),
              pinned: bool(body.pinned),
              status: str(body.status) as store.Status | undefined,
              topic_key: body.topic_key === null ? null : str(body.topic_key),
              evidence: body.evidence === undefined ? undefined : (body.evidence as store.Evidence[]),
              expectedVersion,
              ...(deviceTag !== undefined || agentTag !== undefined
                ? { device: deviceTag ?? null, agent: agentTag ?? null }
                : {}),
            },
            'web',
          );
          if (scope === 'user') {
            // Multi-user: each user's '@user' row is their own; the legacy
            // fixed-id row only applies to single-user mode.
            const userProjectId = ensureUserProject(db, authCtx.userId).id;
            if (userProjectId !== currentProjectId) store.moveMemory(db, id, userProjectId, 'web');
          }
          const ttlDays = num(body.ttl_days);
          const expiresAt = str(body.expires_at) ?? (ttlDays !== undefined && ttlDays > 0
            ? new Date(Date.now() + ttlDays * 86_400_000).toISOString()
            : ttlDays === 0 ? null : undefined);
          if (expiresAt !== undefined) {
            db.prepare('UPDATE memories SET expires_at = ? WHERE id = ?').run(expiresAt, id);
          }
          const fresh = store.getMemory(db, id);
          const finalMemory = fresh ?? updated;
          // Re-embed when the indexed text changed; otherwise the vector goes stale.
          if (str(body.title) !== undefined || str(body.content) !== undefined) {
            await vec.embedMemoryBestEffort(db, embedder, finalMemory);
          }
          return sendJson(res, 200, { memory: finalMemory });
        }
        if (method === 'DELETE') {
          const memory = store.getMemory(db, id);
          if (!memory) return sendJson(res, 404, { error: 'not found' });
          store.deleteMemory(db, memory.project_id, id, 'web');
          return sendJson(res, 200, { deleted: true, id });
        }
      }
    }

    // ---- review -----------------------------------------------------------
    if (resource === 'review') {
      if (method === 'GET') {
        const projectRef = url.searchParams.get('project') ?? undefined;
        const projectId = projectRef ? resolveChecked(projectRef, 'read').id : undefined;
        return sendJson(res, 200, { overdue: store.reviewList(db, projectId) });
      }
      if (method === 'POST') {
        const body = await readJsonBody(req);
        const id = str(body.id);
        const projectRef = str(body.project);
        if (!id || !projectRef) return sendJson(res, 400, { error: 'project and id are required' });
        const project = resolveChecked(projectRef, 'read');
        const memory = store.markReviewed(db, project.id, id, 'web');
        return sendJson(res, 200, { memory });
      }
    }

    // ---- gc ----------------------------------------------------------------
    if (resource === 'gc' && method === 'POST') {
      const result = store.sweepExpired(db, 'web');
      return sendJson(res, 200, result);
    }

    // ---- audit ----------------------------------------------------------
    if (resource === 'audit' && method === 'GET') {
      const projectRef = url.searchParams.get('project') ?? undefined;
      const projectId = projectRef ? resolveChecked(projectRef, 'read').id : undefined;
      const entries = store.recentAudit(db, {
        projectId,
        limit: intParam('limit', 50),
      });
      return sendJson(res, 200, { entries });
    }

    // ---- stats ----------------------------------------------------------
    if (resource === 'stats' && method === 'GET') {
      const projectRef = url.searchParams.get('project') ?? undefined;
      const projectId = projectRef ? resolveChecked(projectRef, 'read').id : undefined;
      return sendJson(res, 200, {
        ...store.projectStats(db, projectId),
        embeddings: store.embeddingStats(db),
        ...(projectId ? {} : { devices: listDevices(db) }),
      });
    }

    // ---- devices ----------------------------------------------------------
    if (resource === 'devices' && method === 'GET') {
      return sendJson(res, 200, { devices: listDevices(db) });
    }

    // ---- scope tree (web hierarchy navigation) -----------------------------
    if (resource === 'tree' && method === 'GET') {
      // Viewer-centric hierarchy: the viewer's own '@user' row is the user
      // node; other users' '@user' rows stay out of the tree (admins reach
      // them through global search). Non-admins see owned + granted projects
      // only, mirroring GET /api/projects. ensureUserProject first so the
      // user node exists even before the first user-level memory.
      const viewerId = authCtx.userId;
      const isAdmin = authCtx.role === 'admin';
      const userProject = ensureUserProject(db, viewerId);
      const rows = db
        .prepare(
          `SELECT p.id, p.name, p.root_path, p.owner_user_id, p.created_at, p.updated_at,
             (SELECT COUNT(*) FROM memories m WHERE m.project_id = p.id AND m.status = 'active') AS active_count,
             (SELECT MAX(m.updated_at) FROM memories m WHERE m.project_id = p.id) AS last_memory_at
           FROM projects p ORDER BY p.name`,
        )
        .all() as Array<{
        id: string;
        name: string;
        root_path: string | null;
        owner_user_id: string | null;
        active_count: number;
        last_memory_at: string | null;
      }>;
      const visible = viewerId && !isAdmin
        ? rows.filter((p) => p.owner_user_id === viewerId || auth.hasActiveGrant(db, viewerId, p.id))
        : rows;
      const userRow = visible.find((p) => p.id === userProject.id);
      const userNode = userRow
        ? (() => {
            const c = store.scopeCounts(db, userRow.id);
            return { id: userRow.id, name: userRow.name, ...c.project };
          })()
        : { id: userProject.id, name: userProject.name, count: 0, pinned: 0 };
      // Other users' '@user' rows stay out of the project tree (admins reach
      // them through global search / the user-level layer).
      const projects = visible
        .filter((p) => p !== userRow && p.name.toLowerCase() !== USER_PROJECT_NAME)
        .map((p) => ({ ...p, ...store.scopeCounts(db, p.id), marker_exists: hasMarker(p.root_path) }));
      return sendJson(res, 200, { user: userNode, projects });
    }

    // ---- brief ------------------------------------------------------------
    if (resource === 'brief' && method === 'GET') {
      const projectRef = url.searchParams.get('project') ?? undefined;
      if (!projectRef) return sendJson(res, 400, { error: 'project is required' });
      // Optional budget: the caller (a host hook) knows how much room the
      // prompt has, and the server owns the invariant rendered ≤ budget.
      const rawBudget = url.searchParams.get('budget');
      let budget: number = store.BRIEF_BUDGET_DEFAULT;
      if (rawBudget !== null && rawBudget !== '') {
        const parsed = Number(rawBudget);
        if (
          !Number.isInteger(parsed) ||
          parsed < store.BRIEF_BUDGET_MIN ||
          parsed > store.BRIEF_BUDGET_MAX
        ) {
          throw new HiveMemError(
            'INVALID_INPUT',
            `budget 必须是 ${store.BRIEF_BUDGET_MIN}..${store.BRIEF_BUDGET_MAX} 的整数（收到 ${rawBudget}）`,
            { hint: '省略 budget 使用默认 2600。该值是字符预算：服务端保证 rendered.length ≤ budget。' },
          );
        }
        budget = parsed;
      }
      const project = resolveChecked(projectRef, 'read');
      const brief = store.bootstrapBrief(db, project.id, budget, undefined, scopeCtx, authCtx.userId);
      return sendJson(res, 200, { project: { id: project.id, name: project.name }, ...brief });
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!(error instanceof HiveMemError)) return sendJson(res, 400, { error: message });
    // Status mapping: a stale version is a conflict (409, retryable after a
    // re-read), a missing revision is 404 — the generic 400 made both
    // indistinguishable from a malformed request.
    const status =
      error.code === 'FORBIDDEN'
        ? 403
        : error.code === 'REVISION_CONFLICT'
          ? 409
          : error.code === 'REVISION_NOT_FOUND' ||
              error.code === 'MEMORY_NOT_FOUND' ||
              error.code === 'PROJECT_NOT_FOUND'
            ? 404
            : 400;
    return sendJson(res, status, {
      error: message,
      code: error.code,
      ...(error.hint ? { hint: error.hint } : {}),
      ...(error.detail ? { detail: error.detail } : {}),
    });
  }
}

function parseSessionCookie(cookie: string | undefined): string | undefined {
  if (!cookie) return undefined;
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === 'hivemem_session') {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

/** Request handler factory: MCP endpoint + authed REST API + web UI. */
export function createHubApp(options: { db: Db; embedder?: Embedder | null; token?: string }) {
  const { db, embedder, token } = options;
  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // Scope context: agent + device identity from request headers. The device
    // falls back to this host's hostname, so single-box setups stay zero-config.
    // The registry only records EXPLICIT header devices — hostname fallback
    // would pollute it with the hub's own name on every web/REST call.
    const headerAgent = req.headers['x-hivemem-agent'];
    const agent = (Array.isArray(headerAgent) ? headerAgent[0] : headerAgent)?.trim() || null;
    const headerDevice = Array.isArray(req.headers['x-hivemem-device'])
      ? req.headers['x-hivemem-device'][0]
      : req.headers['x-hivemem-device'];
    const explicitDevice = normalizeScopeName(headerDevice);
    const device = resolveDevice(headerDevice);
    const scopeCtx: ScopeContext = { device, agent };
    if ((url.pathname === '/mcp' || url.pathname.startsWith('/api/')) && explicitDevice) {
      try {
        registerDevice(db, explicitDevice, agent ?? 'http');
      } catch {
        /* device registry is best-effort */
      }
    }

    // Authentication: Bearer token (MCP clients / REST) or web session cookie.
    // Legacy single-user mode (no users yet) keeps the env-token behavior.
    const sessionToken = parseSessionCookie(req.headers.cookie);
    const authCtx =
      auth.authenticateBearer(db, req.headers.authorization, token) ??
      auth.authenticateSession(db, sessionToken);
    const authRequired = auth.userCount(db) > 0 || Boolean(token);
    // `/api/auth/me` stays reachable without credentials (like /api/auth/login):
    // it is the web UI's mode-discovery probe and answers only "who am I" and
    // "is this hub multi-user". Without the exemption the client cannot learn
    // the mode before authenticating and falls back to the legacy token prompt,
    // producing two stacked login layers on multi-user hubs.
    if (
      authRequired &&
      !authCtx &&
      url.pathname !== '/api/auth/login' &&
      url.pathname !== '/api/auth/me'
    ) {
      if (url.pathname === '/mcp') {
        res.writeHead(401, { 'WWW-Authenticate': 'Bearer' });
        res.end();
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        sendJson(res, 401, { error: 'unauthorized: missing or invalid credentials' });
        return;
      }
    }
    const requestAuth = authCtx ?? auth.LEGACY_AUTH;

    // MCP endpoint: stateless streamable HTTP, a fresh server per request.
    if (url.pathname === '/mcp') {
      if (req.method !== 'POST') {
        res.writeHead(405, { Allow: 'POST' });
        res.end();
        return;
      }
      // Per-client identity: X-HiveMem-Agent (e.g. "dsh", "claude-code") and
      // X-HiveMem-Device attribute writes to the right tool and machine.
      console.error(
        `[hivemem] MCP request from agent=${agent ?? 'unknown'} device=${device ?? 'unknown'} method=${req.method}`,
      );
      const mcp = createMcpServer({
        db,
        cwd: process.cwd(),
        httpMode: true,
        embedder,
        agent: agent ?? undefined,
        device,
        auth: requestAuth,
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => {
        mcp.close().catch(() => {});
      });
      try {
        await mcp.connect(transport);
        await transport.handleRequest(req, res);
      } catch (error) {
        console.error('[hivemem] MCP request failed:', error instanceof Error ? error.message : error);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      await handleApi(db, embedder, req, res, url, scopeCtx, requestAuth);
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      try {
        const html = readFileSync(webAssetPath(), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`web UI unavailable: ${error instanceof Error ? error.message : error}`);
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  };
}

/** Start the HiveMem hub: MCP endpoint + REST API + web management platform, one process. */
export async function startHub(options: HubOptions): Promise<Server> {
  const db = options.db ?? openDb(options.dbPath ?? defaultDbPath());
  const host = options.host ?? '127.0.0.1';
  const handler = createHubApp({ db, embedder: options.embedder, token: options.token });
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(options.port, host, resolve));
  try {
    const swept = store.sweepExpired(db, 'startup');
    if (swept.archived > 0) console.error(`[hivemem] 启动清扫：${swept.archived} 条过期记忆已归档`);
  } catch (error) {
    console.error('[hivemem] 启动清扫失败:', error instanceof Error ? error.message : error);
  }
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : options.port;
  console.error(`HiveMem hub 已启动:`);
  console.error(`  MCP 端点:   http://${host}:${actualPort}/mcp`);
  console.error(`  管理平台:   http://${host}:${actualPort}/`);
  console.error(`  REST API:   http://${host}:${actualPort}/api/*`);
  console.error(`  数据库:     ${options.dbPath ?? '(external db)'}`);
  const users = auth.userCount(db);
  console.error(
    `  认证:       ${users > 0 ? `多用户模式（${users} 个用户）` : options.token ? 'Bearer token 已启用（单用户）' : '未启用（仅限本机使用）'}`,
  );
  console.error(
    `  语义检索:   ${options.embedder ? `已启用（${options.embedder.modelName}）` : '未启用（词法检索）'}`,
  );

  const shutdown = () => {
    server.close();
    server.closeAllConnections?.();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
}

