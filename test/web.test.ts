import test from 'node:test';
import assert from 'node:assert/strict';
import * as auth from '../src/auth.js';
import { ensureProject } from '../src/projects.js';
import { startHub } from '../src/http.js';
import * as store from '../src/store.js';
import { fixture } from './helpers.js';

/**
 * Web console v0.3 surface: the scope-tree endpoint, exact device/agent tag
 * filters on memory retrieval, and explicit scope tags on REST writes (the
 * panel manages other devices' memories without inheriting the hub host's
 * identity).
 */

test('scopeCounts：项目/设备/工具/全设备 分组计数', () => {
  const f = fixture();
  try {
    const p = ensureProject(f.db, f.projDir, { withMarker: false });
    store.writeMemory(f.db, { projectId: p.id, title: 'a', content: 'x', kind: 'fact' });
    store.writeMemory(f.db, { projectId: p.id, title: 'b', content: 'x', kind: 'fact' });
    store.writeMemory(f.db, { projectId: p.id, title: 'd1', content: 'x', kind: 'fact', device: 'desk-a' });
    store.writeMemory(f.db, { projectId: p.id, title: 'd1-agent', content: 'x', kind: 'fact', device: 'desk-a', agent: 'zcode' });
    // All-devices agent row: device NULL ∧ agent set (DESIGN §13 flexibility).
    store.writeMemory(f.db, { projectId: p.id, title: 'any-dev-agent', content: 'x', kind: 'fact', device: null, agent: 'dsh' });
    // Archived rows do not count.
    const archived = store.writeMemory(f.db, { projectId: p.id, title: 'old', content: 'x', kind: 'fact' });
    store.updateMemory(f.db, p.id, archived.id, { status: 'archived' });

    const c = store.scopeCounts(f.db, p.id);
    assert.equal(c.project.count, 2);
    assert.equal(c.devices.length, 2);
    const deskA = c.devices.find((d) => d.name === 'desk-a');
    assert.ok(deskA);
    assert.equal(deskA.count, 1); // device-scope only
    assert.deepEqual(deskA.agents, [{ name: 'zcode', count: 1, pinned: 0 }]);
    const allDev = c.devices.find((d) => d.name === null);
    assert.ok(allDev, 'device=NULL agent rows group under the all-devices node');
    assert.deepEqual(allDev.agents, [{ name: 'dsh', count: 1, pinned: 0 }]);
  } finally {
    f.cleanup();
  }
});

test('hub 端到端：/api/tree 层次结构 + device/agent 过滤 + 显式标签写入', async () => {
  const f = fixture();
  const server = await startHub({ db: f.db, port: 0 });
  try {
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const json = async (path: string, init?: RequestInit) => {
      const res = await fetch(base + path, init);
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
    };
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      json(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const patch = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      json(path, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

    const proj = await post('/api/projects', { name: 'treeproj' });
    const pid = proj.body.project.id as string;

    // Layered writes: project / device (explicit tag, no header) / agent
    // (explicit tags, all-devices variant) / user.
    await post('/api/memories', { project: 'treeproj', title: 'p1', content: 'x', kind: 'fact' });
    const devWrite = await post('/api/memories', {
      project: 'treeproj', title: 'd1', content: 'x', kind: 'fact',
      scope: 'device', device: 'macbook-air',
    });
    assert.equal(devWrite.status, 201);
    assert.equal(devWrite.body.memory.device, 'macbook-air');
    assert.equal(devWrite.body.memory.scope, 'device');
    const agentWrite = await post('/api/memories', {
      project: 'treeproj', title: 'a1', content: 'x', kind: 'fact',
      scope: 'agent', device: '', agent: 'dsh',
    });
    assert.equal(agentWrite.status, 201);
    assert.equal(agentWrite.body.memory.device, null, 'empty device = all-devices agent row');
    assert.equal(agentWrite.body.memory.agent, 'dsh');
    assert.equal(agentWrite.body.memory.scope, 'agent');
    await post('/api/memories', { title: 'u1', content: 'x', kind: 'preference', scope: 'user' });

    // scope=agent without any agent identity still refuses to degrade.
    const noAgent = await post('/api/memories', {
      project: 'treeproj', title: 'x', content: 'x', kind: 'fact', scope: 'agent',
    });
    assert.equal(noAgent.status, 400);

    // --- /api/tree ---
    const tree = await json('/api/tree');
    assert.equal(tree.status, 200);
    assert.equal(tree.body.user.name, '@user');
    assert.equal(tree.body.user.count, 1);
    const tp = tree.body.projects.find((p: any) => p.id === pid);
    assert.ok(tp);
    assert.equal(tp.project.count, 1);
    assert.equal(tp.devices.length, 2);
    const mb = tp.devices.find((d: any) => d.name === 'macbook-air');
    assert.equal(mb.count, 1);
    const allDev = tp.devices.find((d: any) => d.name === null);
    assert.deepEqual(allDev.agents, [{ name: 'dsh', count: 1, pinned: 0 }]);

    // --- exact tag filters ---
    const devHits = await json(`/api/memories?project=${pid}&scope=device&device=macbook-air`);
    assert.deepEqual(devHits.body.hits.map((h: any) => h.title), ['d1']);
    const agentHits = await json(`/api/memories?project=${pid}&scope=agent&device=&agent=dsh`);
    assert.deepEqual(agentHits.body.hits.map((h: any) => h.title), ['a1']);
    const projHits = await json(`/api/memories?project=${pid}&scope=project`);
    assert.deepEqual(projHits.body.hits.map((h: any) => h.title), ['p1']);
    const userHits = await json(`/api/memories?scope=user`);
    assert.deepEqual(userHits.body.hits.map((h: any) => h.title), ['u1']);

    // --- PATCH: tag-only migration (device re-assignment) + topic_key ---
    const devId = devWrite.body.memory.id as string;
    const moved = await patch(`/api/memories/${devId}`, {
      scope: 'device', device: 'desk-b',
    });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.memory.device, 'desk-b');
    assert.equal(moved.body.memory.scope, 'device');
    const topicSet = await patch(`/api/memories/${devId}`, { topic_key: 'env/jdk-path' });
    assert.equal(topicSet.body.memory.topic_key, 'env/jdk-path');
    const topicClear = await patch(`/api/memories/${devId}`, { topic_key: null });
    assert.equal(topicClear.body.memory.topic_key, null);

    // --- PATCH: scope migration device → project clears tags ---
    const up = await patch(`/api/memories/${devId}`, { scope: 'project' });
    assert.equal(up.body.memory.device, null);
    assert.equal(up.body.memory.scope, 'project');
  } finally {
    server.close();
    f.cleanup();
  }
});

test('hub 多用户：/api/tree 可见性过滤 + 第二用户 @user 作用域派生', async () => {
  const f = fixture();
  try {
    const { user: admin } = auth.createUser(f.db, { name: 'boss', password: 'adminpass' });
    const { user: alice } = auth.createUser(f.db, { name: 'alice', password: 'alicepass' });
    const { token: adminTok } = auth.createToken(f.db, admin.id, 'cli');
    const { token: aliceTok } = auth.createToken(f.db, alice.id, 'cli');
    const adminH = { Authorization: `Bearer ${adminTok}` };
    const aliceH = { Authorization: `Bearer ${aliceTok}` };

    const proj = ensureProject(f.db, f.projDir, { withMarker: false, ownerUserId: admin.id });
    store.writeMemory(f.db, { projectId: proj.id, title: 'admin-fact', content: 'x', kind: 'fact' });

    // Alice writes her own user-level memory (per-user '@user' row).
    const server = await startHub({ db: f.db, port: 0 });
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const json = async (path: string, init?: RequestInit) => {
      const res = await fetch(base + path, init);
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
    };

    const write = await json('/api/memories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...aliceH },
      body: JSON.stringify({ title: 'alice-pref', content: 'x', kind: 'preference', scope: 'user' }),
    });
    assert.equal(write.status, 201);
    assert.equal(write.body.memory.scope, 'user', 'per-user @user rows derive scope=user');

    // scope=user filter finds alice's row (name-based subquery, not the
    // legacy fixed prj_user id).
    const aliceUserHits = await json('/api/memories?scope=user', { headers: aliceH });
    assert.deepEqual(aliceUserHits.body.hits.map((h: any) => h.title), ['alice-pref']);
    assert.equal(aliceUserHits.body.hits[0].scope, 'user');

    // Alice's tree: only her @user node, no admin projects.
    const aliceTree = await json('/api/tree', { headers: aliceH });
    assert.equal(aliceTree.status, 200);
    assert.equal(aliceTree.body.user.count, 1);
    assert.equal(aliceTree.body.projects.length, 0, 'no owned or granted projects yet');

    // Grant read on the project → it appears in alice's tree with readonly
    // semantics (tree only lists; write stays forbidden).
    auth.grantAccess(f.db, { grantorUserId: admin.id, granteeUserId: alice.id, projectId: proj.id });
    const aliceTree2 = await json('/api/tree', { headers: aliceH });
    assert.equal(aliceTree2.body.projects.length, 1);
    assert.equal(aliceTree2.body.projects[0].name, proj.name);

    // Admin's tree: own @user node present; other users' @user rows stay out
    // of the project list.
    const adminTree = await json('/api/tree', { headers: adminH });
    assert.equal(adminTree.body.user.count, 0);
    const names = adminTree.body.projects.map((p: any) => p.name);
    assert.ok(!names.includes('@user'), 'other users @user rows are not project nodes');

    // byScope stats count alice's user-level row as 'user'.
    const stats = await json(`/api/stats?project=${proj.id}`, { headers: adminH });
    const byScope = new Map<string, number>(stats.body.byScope.map((s: any) => [s.scope, s.n]));
    assert.equal(byScope.get('project'), 1);

    server.close();
  } finally {
    f.cleanup();
  }
});
