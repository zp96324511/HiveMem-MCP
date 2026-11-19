import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import * as auth from '../src/auth.js';
import { deleteProject, ensureProject, ensureUserProject, hasMarker } from '../src/projects.js';
import { startHub } from '../src/http.js';
import * as store from '../src/store.js';
import { fixture } from './helpers.js';

/**
 * Project deletion (web panel + REST). Deleting a project is a cascade: its
 * memories, their vectors, path aliases and grants all go with it, the FTS
 * index must stay consistent, and the audit trail must outlive the rows it
 * describes. The reserved '@user' row is never deletable, and a non-empty
 * project cannot be deleted without echoing its name.
 */

test('deleteProject：级联清除记忆/别名/授权/向量，FTS 保持同步，审计留痕', () => {
  const f = fixture();
  try {
    const p = ensureProject(f.db, f.projDir, { withMarker: true });
    const m1 = store.writeMemory(f.db, {
      projectId: p.id,
      title: 'galaxy build notes',
      content: 'nebula configuration lives here',
      kind: 'fact',
    });
    store.writeMemory(f.db, { projectId: p.id, title: 'device note', content: 'x', kind: 'fact', device: 'desk-a' });
    // Second path alias (a moved/remounted directory of the same project).
    f.db.prepare('INSERT INTO project_aliases (alias_path, project_id) VALUES (?, ?)').run('q:/moved/proj', p.id);
    // A derived vector row must not outlive its memory.
    f.db
      .prepare(
        'INSERT INTO memory_embeddings (memory_id, model_name, dim, vector, embedded_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(m1.id, 'test-model', 2, Buffer.from(new Float32Array([0.5, -0.5]).buffer), new Date().toISOString());

    const { user: admin } = auth.createUser(f.db, { name: 'boss', password: 'adminpass' });
    const { user: alice } = auth.createUser(f.db, { name: 'alice', password: 'alicepass' });
    auth.grantAccess(f.db, { grantorUserId: admin.id, granteeUserId: alice.id, projectId: p.id });

    // Baseline.
    assert.ok(store.searchMemories(f.db, { query: 'galaxy build' }).total >= 1);
    assert.equal(hasMarker(p.root_path), true);

    const result = deleteProject(f.db, p.id, { removeMarker: true, actor: 'web' });
    assert.equal(result.id, p.id);
    assert.equal(result.memories, 2);
    assert.equal(result.aliases, 2);
    assert.equal(result.grants, 1);
    assert.equal(result.marker_existed, true);
    assert.equal(result.marker_removed, true);

    const count = (sql: string): number => (f.db.prepare(sql).get() as { n: number }).n;
    assert.equal(count(`SELECT COUNT(*) AS n FROM projects WHERE id = '${p.id}'`), 0);
    assert.equal(count('SELECT COUNT(*) AS n FROM memories'), 0);
    assert.equal(count('SELECT COUNT(*) AS n FROM memory_embeddings'), 0);
    assert.equal(count('SELECT COUNT(*) AS n FROM project_aliases'), 0);
    assert.equal(count('SELECT COUNT(*) AS n FROM grants'), 0);
    assert.equal(hasMarker(p.root_path), false, 'marker file removed from the directory');
    assert.equal(existsSync(path.join(f.projDir, '.hivemem', 'project.json')), false);

    // The external-content FTS index must agree with the content table again.
    assert.doesNotThrow(() =>
      f.db.exec("INSERT INTO memories_fts(memories_fts) VALUES('integrity-check')"),
    );
    assert.equal(store.searchMemories(f.db, { query: 'galaxy build' }).total, 0);

    const audit = f.db
      .prepare("SELECT detail FROM audit_log WHERE action = 'project_delete'")
      .all() as Array<{ detail: string }>;
    assert.equal(audit.length, 1);
    assert.equal(JSON.parse(audit[0].detail).name, p.name);
  } finally {
    f.cleanup();
  }
});

test('deleteProject 拒绝保留项目与不存在的项目', () => {
  const f = fixture();
  try {
    const userProject = ensureUserProject(f.db);
    assert.throws(() => deleteProject(f.db, userProject.id), /保留项目/);
    assert.throws(() => deleteProject(f.db, 'prj_does_not_exist'), /不存在/);
  } finally {
    f.cleanup();
  }
});

test('hub 端到端：删除非空项目需 confirm=项目名（大小写不敏感），删除后列表/树中消失', async () => {
  const f = fixture();
  const server = await startHub({ db: f.db, port: 0 });
  try {
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const json = async (p: string, init?: RequestInit) => {
      const res = await fetch(base + p, init);
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
    };
    const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
      json(p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

    const proj = await post('/api/projects', { name: 'delme' });
    const id = proj.body.project.id as string;
    await post('/api/memories', { project: 'delme', title: 'a', content: 'b', kind: 'fact' });

    const noConfirm = await json(`/api/projects/${id}`, { method: 'DELETE' });
    assert.equal(noConfirm.status, 400);
    assert.equal(noConfirm.body.confirm_required, 'delme');
    assert.equal(noConfirm.body.memories, 1);

    assert.equal((await json(`/api/projects/${id}?confirm=other`, { method: 'DELETE' })).status, 400);
    // Still there after the refusals.
    assert.ok((await json('/api/projects')).body.projects.some((p: any) => p.id === id));

    const ok = await json(`/api/projects/${id}?confirm=DelMe`, { method: 'DELETE' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.deleted, true);
    assert.equal(ok.body.memories, 1);
    assert.equal(ok.body.name, 'delme');

    assert.ok(!(await json('/api/projects')).body.projects.some((p: any) => p.id === id));
    assert.ok(!(await json('/api/tree')).body.projects.some((p: any) => p.id === id));
    assert.equal((await json(`/api/projects/${id}`, { method: 'DELETE' })).status, 404);

    // An empty project needs no name echo.
    const empty = await post('/api/projects', { name: 'empty-proj' });
    const del2 = await json(`/api/projects/${empty.body.project.id}`, { method: 'DELETE' });
    assert.equal(del2.status, 200);
    assert.equal(del2.body.memories, 0);
  } finally {
    server.close();
    server.closeAllConnections?.();
    f.cleanup();
  }
});

test('hub 端到端：只剩归档记忆的项目同样要求 confirm（树里 active_count=0，级联却非空）', async () => {
  const f = fixture();
  const server = await startHub({ db: f.db, port: 0 });
  try {
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const json = async (p: string, init?: RequestInit) => {
      const res = await fetch(base + p, init);
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
    };
    const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
      json(p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

    const proj = await post('/api/projects', { name: 'history-only' });
    const id = proj.body.project.id as string;
    const mem = await post('/api/memories', { project: 'history-only', title: 'old note', content: 'x', kind: 'fact' });
    store.updateMemory(f.db, id, mem.body.memory.id, { status: 'archived' });

    // The panel's tree count is active-only: it shows 0 for this project.
    const node = (await json('/api/tree')).body.projects.find((p: any) => p.id === id);
    assert.equal(node.active_count, 0, '树里计数为 0（归档不计数）');

    // But the hub's cascade guard counts every status.
    const refused = await json(`/api/projects/${id}`, { method: 'DELETE' });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.confirm_required, 'history-only');
    assert.equal(refused.body.memories, 1, '服务端按全部状态计数');

    const ok = await json(`/api/projects/${id}?confirm=history-only`, { method: 'DELETE' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.memories, 1);
  } finally {
    server.close();
    server.closeAllConnections?.();
    f.cleanup();
  }
});

test('面板：删除弹窗无条件渲染项目名输入框（旧版按 active_count 门控 → 无输入可填却必被 400 拒绝）', async () => {
  const f = fixture();
  const server = await startHub({ db: f.db, port: 0 });
  try {
    const port = (server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /openProjectDelete/);
    assert.match(html, /id: 'confirm'/, '确认输入框存在');
    assert.doesNotMatch(
      html,
      /if \(memories > 0\) fields\.push\(\{ id: 'confirm'/,
      '输入框不得按本地 active 计数门控',
    );
    assert.match(html, /confirm_required/, '400 的结构化响应被用于弹窗内提示');
  } finally {
    server.close();
    server.closeAllConnections?.();
    f.cleanup();
  }
});

test('hub 端到端：仅所有者/管理员可删、@user 拒绝删除、remove_marker 移除目录标记', async () => {
  const f = fixture();
  const server = await startHub({ db: f.db, port: 0 });
  try {
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const json = async (p: string, init?: RequestInit) => {
      const res = await fetch(base + p, init);
      return {
        status: res.status,
        body: (await res.json().catch(() => ({}))) as Record<string, any>,
        setCookie: res.headers.get('set-cookie'),
      };
    };
    const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
      json(p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

    // Directory-registered project with a marker, then the first user (admin)
    // claims it as owner.
    const legacy = ensureProject(f.db, f.projDir, { withMarker: true });
    assert.equal(hasMarker(legacy.root_path), true);
    const boot = await post('/api/users', { name: 'boss', password: 'adminpass' });
    assert.equal(boot.status, 201);
    const login = await post('/api/auth/login', { name: 'boss', password: 'adminpass' });
    const adminHeaders = { Cookie: (login.setCookie ?? '').split(';')[0] };
    const u2 = await post('/api/users', { name: 'alice', password: 'alicepass' }, adminHeaders);
    const aliceToken = (
      await post(`/api/users/${u2.body.user.id}/tokens`, { name: 'cli' }, adminHeaders)
    ).body.token as string;
    const aliceHeaders = { Authorization: `Bearer ${aliceToken}` };

    // A read grant is not a delete right.
    assert.equal(
      (await json(`/api/projects/${legacy.id}?confirm=x`, { method: 'DELETE', headers: aliceHeaders })).status,
      403,
    );
    await post('/api/grants', { grantee_name: 'alice', project_id: legacy.id }, adminHeaders);
    assert.equal(
      (await json(`/api/projects/${legacy.id}?confirm=x`, { method: 'DELETE', headers: aliceHeaders })).status,
      403,
    );

    // '@user' is a reserved container, never a deletable project.
    const tree = await json('/api/tree', { headers: adminHeaders });
    const userRowId = tree.body.user.id as string;
    assert.equal(
      (await json(`/api/projects/${userRowId}?confirm=@user`, { method: 'DELETE', headers: adminHeaders })).status,
      409,
    );
    assert.ok((await json('/api/tree', { headers: adminHeaders })).body.user, 'user node still present');

    // Admin deletes, removing the identity marker so the project does not come
    // back with the same id on the next path reference.
    const del = await json(`/api/projects/${legacy.id}?remove_marker=1`, { method: 'DELETE', headers: adminHeaders });
    assert.equal(del.status, 200);
    assert.equal(del.body.marker_existed, true);
    assert.equal(del.body.marker_removed, true);
    assert.equal(hasMarker(legacy.root_path), false);
    assert.ok(!(await json('/api/projects', { headers: adminHeaders })).body.projects.some((p: any) => p.id === legacy.id));
  } finally {
    server.close();
    server.closeAllConnections?.();
    f.cleanup();
  }
});
