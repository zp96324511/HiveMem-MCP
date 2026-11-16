import test from 'node:test';
import assert from 'node:assert/strict';
import * as auth from '../src/auth.js';
import { ensureProject } from '../src/projects.js';
import { startHub } from '../src/http.js';
import { fixture } from './helpers.js';

test('auth 基元：scrypt 往返、错误密码拒绝、token 哈希确定', () => {
  const hash = auth.hashPassword('s3cret-pass');
  assert.ok(hash.startsWith('scrypt$'));
  assert.equal(auth.verifyPassword('s3cret-pass', hash), true);
  assert.equal(auth.verifyPassword('wrong', hash), false);
  assert.equal(auth.hashToken('abc'), auth.hashToken('abc'));
  assert.notEqual(auth.hashToken('abc'), auth.hashToken('abd'));
});

test('首用户强制 admin 并认领无主项目；后续用户为普通角色', () => {
  const f = fixture();
  try {
    const project = ensureProject(f.db, f.projDir, { withMarker: true });
    assert.equal(project.owner_user_id, null);
    const { user: admin } = auth.createUser(f.db, { name: 'boss', password: 'adminpass' });
    assert.equal(admin.role, 'admin');
    const owned = f.db
      .prepare('SELECT owner_user_id FROM projects WHERE id = ?')
      .get(project.id) as { owner_user_id: string };
    assert.equal(owned.owner_user_id, admin.id);
    const { user: u2 } = auth.createUser(f.db, { name: 'alice', password: 'alicepass' });
    assert.equal(u2.role, 'user');
    assert.throws(() => auth.createUser(f.db, { name: 'Alice', password: 'xxxxxx' }), /已存在/);
    assert.throws(() => auth.createUser(f.db, { name: 'x', password: '123' }), /至少 6 位/);
  } finally {
    f.cleanup();
  }
});

test('legacy 模式：无用户时 env token 行为与从前完全一致', () => {
  const f = fixture();
  try {
    assert.equal(auth.userCount(f.db), 0);
    assert.equal(auth.authenticateBearer(f.db, undefined, undefined)?.role, 'admin');
    assert.equal(auth.authenticateBearer(f.db, 'Bearer wrong', 'tok123'), null);
    assert.equal(auth.authenticateBearer(f.db, 'Bearer tok123', 'tok123')?.via, 'legacy');
  } finally {
    f.cleanup();
  }
});

test('token 认证与吊销：哈希查表、吊销即时生效', () => {
  const f = fixture();
  try {
    const { user } = auth.createUser(f.db, { name: 'u', password: 'pass123' });
    const { token } = auth.createToken(f.db, user.id, 'cli');
    const ctx = auth.authenticateBearer(f.db, `Bearer ${token}`);
    assert.equal(ctx?.userId, user.id);
    assert.equal(ctx?.via, 'token');
    assert.equal(auth.authenticateBearer(f.db, `Bearer ${'0'.repeat(64)}`), null);
    const tokens = auth.listTokens(f.db, user.id);
    auth.revokeToken(f.db, tokens[0].id);
    assert.equal(auth.authenticateBearer(f.db, `Bearer ${token}`), null);
  } finally {
    f.cleanup();
  }
});

test('web 会话：创建/认证/登出；改密码使全部会话失效', () => {
  const f = fixture();
  try {
    const { user } = auth.createUser(f.db, { name: 'u', password: 'pass123' });
    const s = auth.createSession(f.db, user.id);
    assert.equal(auth.authenticateSession(f.db, s.token)?.userId, user.id);
    assert.equal(auth.authenticateSession(f.db, s.token)?.via, 'session');
    assert.equal(auth.authenticateSession(f.db, 'garbage'), null);
    auth.deleteSession(f.db, s.token);
    assert.equal(auth.authenticateSession(f.db, s.token), null);
    const s2 = auth.createSession(f.db, user.id);
    auth.setUserPassword(f.db, user.id, 'newpass123');
    assert.equal(auth.authenticateSession(f.db, s2.token), null);
    assert.equal(auth.verifyPassword('newpass123', auth.getUserById(f.db, user.id)!.password_hash), true);
  } finally {
    f.cleanup();
  }
});

test('访问检查：所有者读写、受权只读、撤销即时、管理员全权', () => {
  const f = fixture();
  try {
    const { user: admin } = auth.createUser(f.db, { name: 'boss', password: 'adminpass' });
    const { user: alice } = auth.createUser(f.db, { name: 'alice', password: 'alicepass' });
    const project = ensureProject(f.db, f.projDir, { withMarker: true, ownerUserId: admin.id });
    const adminCtx = { userId: admin.id, name: admin.name, role: 'admin' as const, via: 'token' as const };
    const aliceCtx = { userId: alice.id, name: alice.name, role: 'user' as const, via: 'token' as const };
    const isForbidden = (e: unknown): boolean =>
      e instanceof Error && (e as { code?: string }).code === 'FORBIDDEN';

    // Owner: read + write.
    auth.assertProjectAccess(f.db, adminCtx, project, 'write');
    auth.assertProjectAccess(f.db, adminCtx, project, 'read');
    // Non-owner without grant: neither.
    assert.throws(() => auth.assertProjectAccess(f.db, aliceCtx, project, 'write'), isForbidden);
    assert.throws(() => auth.assertProjectAccess(f.db, aliceCtx, project, 'read'), isForbidden);
    // Grant → read only.
    const grant = auth.grantAccess(f.db, {
      grantorUserId: admin.id,
      granteeUserId: alice.id,
      projectId: project.id,
    });
    auth.assertProjectAccess(f.db, aliceCtx, project, 'read');
    assert.throws(() => auth.assertProjectAccess(f.db, aliceCtx, project, 'write'), isForbidden);
    // Revoke → immediate.
    auth.revokeGrant(f.db, grant.id);
    assert.throws(() => auth.assertProjectAccess(f.db, aliceCtx, project, 'read'), isForbidden);
    // Platform admin bypasses everything.
    const superAdmin = { userId: 'usr_someoneelse', name: 'root', role: 'admin' as const, via: 'token' as const };
    auth.assertProjectAccess(f.db, superAdmin, project, 'write');
  } finally {
    f.cleanup();
  }
});

test('hub 多用户端到端：legacy → 首用户 → 隔离 → 授权 → 撤销 → 每用户 @user', async () => {
  const f = fixture();
  const server = await startHub({ db: f.db, port: 0 });
  try {
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const json = async (path: string, init?: RequestInit) => {
      const res = await fetch(base + path, init);
      return {
        status: res.status,
        body: (await res.json().catch(() => ({}))) as Record<string, any>,
        setCookie: res.headers.get('set-cookie'),
      };
    };
    const post = (path: string, body: unknown, headers: Record<string, string>) =>
      json(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });

    // 1) Legacy open mode: writes work without credentials (backward compat).
    const legacyProject = await post('/api/projects', { name: 'legacy-proj' }, {});
    assert.equal(legacyProject.status, 201);
    const legacyId = legacyProject.body.project.id as string;
    const legacyWrite = await post(
      '/api/memories',
      { project: 'legacy-proj', title: 't', content: 'c', kind: 'fact' },
      {},
    );
    assert.equal(legacyWrite.status, 201);

    // 2) Bootstrap the first user (legacy admin context passes the gate).
    const created = await post('/api/users', { name: 'boss', password: 'adminpass' }, {});
    assert.equal(created.status, 201);
    const adminId = created.body.user.id as string;

    // 3) Multi-user mode is ON: anonymous requests are rejected.
    assert.equal((await json('/api/projects')).status, 401);

    // 3b) Mode discovery stays open: /api/auth/me answers anonymously (user
    //     null, multiUser true) so the web UI shows the password page instead
    //     of the legacy Bearer-token prompt.
    const me = await json('/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.user, null);
    assert.equal(me.body.multiUser, true);

    // 4) Admin login → session cookie; wrong password rejected.
    const login = await post('/api/auth/login', { name: 'boss', password: 'adminpass' }, {});
    assert.equal(login.status, 200);
    const cookie = (login.setCookie ?? '').split(';')[0];
    assert.ok(cookie.startsWith('hivemem_session='));
    const adminHeaders = { Cookie: cookie };
    assert.equal(
      (await post('/api/auth/login', { name: 'boss', password: 'nope' }, {})).status,
      401,
    );

    // 5) Create user2 and mint an MCP token for them.
    const u2 = await post('/api/users', { name: 'alice', password: 'alicepass' }, adminHeaders);
    assert.equal(u2.status, 201);
    const aliceId = u2.body.user.id as string;
    const tok = await post(`/api/users/${aliceId}/tokens`, { name: 'cli' }, adminHeaders);
    assert.equal(tok.status, 201);
    const aliceToken = tok.body.token as string;
    const aliceHeaders = { Authorization: `Bearer ${aliceToken}` };

    // 6) Alice creates her own project and writes into it.
    const aproj = await post('/api/projects', { name: 'alice-proj' }, aliceHeaders);
    assert.equal(aproj.status, 201);
    assert.equal(aproj.body.project.owner_user_id, aliceId);
    assert.equal(
      (
        await post(
          '/api/memories',
          { project: 'alice-proj', title: 'a', content: 'b', kind: 'fact' },
          aliceHeaders,
        )
      ).status,
      201,
    );

    // 7) Isolation: alice cannot reach the admin's project — by name it does
    //    not even resolve (no leak: 404, indistinguishable from "no such"),
    //    by id it is an explicit 403.
    assert.equal((await json('/api/memories?project=legacy-proj', { headers: aliceHeaders })).status, 404);
    assert.equal((await json(`/api/memories?project=${legacyId}`, { headers: aliceHeaders })).status, 403);

    // 8) Grant read-only: alice can read but still cannot write.
    const grant = await post('/api/grants', { grantee_name: 'alice', project_id: legacyId }, adminHeaders);
    assert.equal(grant.status, 201);
    assert.equal((await json(`/api/memories?project=${legacyId}`, { headers: aliceHeaders })).status, 200);
    assert.equal(
      (
        await post('/api/memories', { project: legacyId, title: 'x', content: 'y', kind: 'fact' }, aliceHeaders)
      ).status,
      403,
    );

    // 9) Revoke: takes effect on the very next request.
    assert.equal(
      (await json(`/api/grants/${grant.body.grant.id}`, { method: 'DELETE', headers: adminHeaders })).status,
      200,
    );
    assert.equal((await json(`/api/memories?project=${legacyId}`, { headers: aliceHeaders })).status, 403);

    // 10) Alice's global search stays inside her accessible set.
    const globalSearch = await json('/api/memories', { headers: aliceHeaders });
    assert.equal(globalSearch.status, 200);
    assert.ok(
      !globalSearch.body.hits.some((h: { project_id: string }) => h.project_id === legacyId),
      'global search must not leak other users\' projects',
    );

    // 11) Per-user '@user' rows: alice's user-level memory lands in her own row.
    const aliceUser = await post(
      '/api/memories',
      { title: '爱丽丝偏好', content: 'x', kind: 'preference', scope: 'user' },
      aliceHeaders,
    );
    assert.equal(aliceUser.status, 201);
    const aliceUserProject = aliceUser.body.memory.project_id as string;
    const adminUser = await post(
      '/api/memories',
      { title: '老板偏好', content: 'x', kind: 'preference', scope: 'user' },
      adminHeaders,
    );
    assert.equal(adminUser.status, 201);
    assert.notEqual(adminUser.body.memory.project_id, aliceUserProject);

    // 12) Alice's brief shows her user-level memory, never the admin's.
    const aBrief = await json('/api/brief?project=alice-proj', { headers: aliceHeaders });
    assert.ok(aBrief.body.rendered.includes('爱丽丝偏好'));
    assert.ok(!aBrief.body.rendered.includes('老板偏好'));

    // 13) Project lists are scoped: alice sees only her own.
    const aProjects = await json('/api/projects', { headers: aliceHeaders });
    assert.ok(
      aProjects.body.projects.every((p: { owner_user_id: string | null }) => p.owner_user_id === aliceId),
    );

    // 14) Admin sees everything; non-admins cannot manage users.
    const allProjects = await json('/api/projects', { headers: adminHeaders });
    assert.equal(allProjects.body.projects.length, 4); // legacy-proj, alice-proj, two @user rows
    assert.equal((await json('/api/users', { headers: aliceHeaders })).status, 403);

    // 15) Token revocation kicks alice out immediately.
    assert.equal(
      (await json(`/api/tokens/${tok.body.id}`, { method: 'DELETE', headers: adminHeaders })).status,
      200,
    );
    assert.equal((await json('/api/projects', { headers: aliceHeaders })).status, 401);
  } finally {
    server.close();
    server.closeAllConnections?.();
    f.cleanup();
  }
});
