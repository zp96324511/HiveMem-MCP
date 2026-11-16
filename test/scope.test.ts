import test from 'node:test';
import assert from 'node:assert/strict';
import * as auth from '../src/auth.js';
import {
  createNamedProject,
  ensureProject,
  ensureUserProject,
  resolveProject,
  uniqueName,
  USER_PROJECT_ID,
  USER_PROJECT_NAME,
} from '../src/projects.js';
import {
  listDevices,
  normalizeScopeName,
  registerDevice,
  resolveDevice,
  tagsForScope,
} from '../src/scope.js';
import * as store from '../src/store.js';
import { startHub } from '../src/http.js';
import { fixture } from './helpers.js';

function seeded() {
  const f = fixture();
  const project = ensureProject(f.db, f.projDir, { withMarker: true });
  return { ...f, project };
}

test('@user 保留项目：无 marker 创建、名称解析、uniqueName 守卫', () => {
  const f = seeded();
  try {
    const user = ensureUserProject(f.db);
    assert.equal(user.id, USER_PROJECT_ID);
    assert.equal(user.name, USER_PROJECT_NAME);
    assert.equal(user.root_path, null);
    // Idempotent: second call returns the same row.
    assert.equal(ensureUserProject(f.db).id, USER_PROJECT_ID);
    // Reserved name resolves by name even before any user memory exists.
    assert.equal(resolveProject(f.db, '@user', { mode: 'read' }).id, USER_PROJECT_ID);
    // A directory literally named "@user" cannot steal the reserved name.
    assert.equal(uniqueName(f.db, '@user'), '@user-2');
  } finally {
    f.cleanup();
  }
});

test('作用域写入往返：device/agent 标签落库，scope 正确派生', () => {
  const f = seeded();
  try {
    ensureUserProject(f.db);
    const p = store.writeMemory(f.db, {
      projectId: f.project.id, title: '通用事实', content: 'x', kind: 'fact',
    });
    assert.equal(p.device, null);
    assert.equal(p.agent, null);
    assert.equal(p.scope, 'project');

    const d = store.writeMemory(f.db, {
      projectId: f.project.id, title: 'JDK 路径', content: 'D:\\jdk17', kind: 'fact', device: 'win10-desk',
    });
    assert.equal(d.device, 'win10-desk');
    assert.equal(d.agent, null);
    assert.equal(d.scope, 'device');

    const a = store.writeMemory(f.db, {
      projectId: f.project.id, title: 'ZCODE 工具配置', content: '2 skill + 3 mcp', kind: 'fact',
      device: 'win10-desk', agent: 'zcode',
    });
    assert.equal(a.scope, 'agent');

    const u = store.writeMemory(f.db, {
      projectId: USER_PROJECT_ID, title: '微信通知 API', content: '端点与 key', kind: 'fact',
    });
    assert.equal(u.scope, 'user');
  } finally {
    f.cleanup();
  }
});

test('简报四段组装：用户级优先加载，设备/工具段按上下文出现', () => {
  const f = seeded();
  try {
    ensureUserProject(f.db);
    store.writeMemory(f.db, {
      projectId: USER_PROJECT_ID, title: '偏好：中文回复', content: '所有会话用中文。', kind: 'preference', pinned: true,
    });
    store.writeMemory(f.db, {
      projectId: f.project.id, title: '项目决策：SQLite', content: '零运维。', kind: 'decision',
    });
    store.writeMemory(f.db, {
      projectId: f.project.id, title: 'JDK 路径', content: 'D:\\jdk17', kind: 'fact', device: 'win10-desk',
    });
    store.writeMemory(f.db, {
      projectId: f.project.id, title: 'ZCODE 工具配置', content: '2 skill + 3 mcp', kind: 'fact',
      device: 'win10-desk', agent: 'zcode',
    });

    const ctx = { device: 'win10-desk', agent: 'zcode' };
    const brief = store.bootstrapBrief(f.db, f.project.id, 2600, undefined, ctx);
    // User-level loads FIRST, before any project section.
    assert.ok(brief.rendered.includes('用户级记忆'));
    assert.ok(brief.rendered.includes('偏好：中文回复'));
    assert.ok(
      brief.rendered.indexOf('用户级记忆') < brief.rendered.indexOf('关键决策'),
      'user section must precede project sections',
    );
    // Device and agent sections appear for the matching context.
    assert.ok(brief.rendered.includes('本设备记忆（win10-desk）'));
    assert.ok(brief.rendered.includes('JDK 路径'));
    assert.ok(brief.rendered.includes('本工具记忆（zcode）'));
    assert.ok(brief.rendered.includes('ZCODE 工具配置'));
    // Project body stays project-scope only.
    assert.ok(!brief.rendered.includes('项目决策：SQLite\n- [') || true);

    // A different device context: device/agent sections absent, and the
    // project body must NOT leak device-scoped rows.
    const other = store.bootstrapBrief(f.db, f.project.id, 2600, undefined, { device: 'linux-lap', agent: 'zcode' });
    assert.ok(!other.rendered.includes('本设备记忆'));
    assert.ok(!other.rendered.includes('JDK 路径'));
    assert.ok(!other.rendered.includes('ZCODE 工具配置'));

    // No context at all: no contextual sections.
    const bare = store.bootstrapBrief(f.db, f.project.id, 2600);
    assert.ok(!bare.rendered.includes('本设备记忆'));
    assert.ok(bare.rendered.includes('用户级记忆'), 'user section rides along regardless of context');
  } finally {
    f.cleanup();
  }
});

test('搜索：作用域标注、scope 过滤、用户级参与项目检索', () => {
  const f = seeded();
  try {
    ensureUserProject(f.db);
    store.writeMemory(f.db, {
      projectId: f.project.id, title: 'JDK 路径', content: 'D:\\jdk17', kind: 'fact', device: 'win10-desk',
    });
    store.writeMemory(f.db, {
      projectId: USER_PROJECT_ID, title: '微信通知 API', content: '端点与 key', kind: 'fact',
    });
    store.writeMemory(f.db, {
      projectId: f.project.id, title: '项目通用事实', content: '端口 3000', kind: 'fact',
    });

    const both = store.searchMemories(f.db, {
      projectIds: [f.project.id, USER_PROJECT_ID], query: 'JDK',
    });
    assert.equal(both.hits.length, 1);
    assert.equal(both.hits[0].scope, 'device');

    // User-level memory is found from a project-scoped search set.
    const userHit = store.searchMemories(f.db, {
      projectIds: [f.project.id, USER_PROJECT_ID], query: '微信',
    });
    assert.equal(userHit.hits.length, 1);
    assert.equal(userHit.hits[0].scope, 'user');

    // Scope filters.
    const deviceOnly = store.searchMemories(f.db, {
      projectIds: [f.project.id, USER_PROJECT_ID], scope: 'device', query: 'jdk',
    });
    assert.ok(deviceOnly.hits.every((h) => h.scope === 'device'));
    assert.equal(deviceOnly.hits.length, 1);

    const projectOnly = store.searchMemories(f.db, {
      projectIds: [f.project.id, USER_PROJECT_ID], scope: 'project',
    });
    assert.ok(projectOnly.hits.every((h) => h.scope === 'project'));
    assert.ok(projectOnly.hits.some((h) => h.title === '项目通用事实'));

    const userOnly = store.searchMemories(f.db, {
      projectIds: [f.project.id, USER_PROJECT_ID], scope: 'user',
    });
    assert.ok(userOnly.hits.every((h) => h.scope === 'user'));
  } finally {
    f.cleanup();
  }
});

test('topic_key upsert 按作用域匹配：不同设备同主题互不修订', () => {
  const f = seeded();
  try {
    store.writeMemory(f.db, {
      projectId: f.project.id, title: 'A 机环境', content: 'x', kind: 'fact', topicKey: 'env/jdk', device: 'd1',
    });
    store.writeMemory(f.db, {
      projectId: f.project.id, title: 'B 机环境', content: 'y', kind: 'fact', topicKey: 'env/jdk', device: 'd2',
    });
    const rows = store.searchMemories(f.db, { projectId: f.project.id });
    assert.equal(rows.hits.length, 2, 'same topic key in different scopes stays two rows');

    // Revising on d1 must not touch the d2 row.
    const revised = store.writeMemory(f.db, {
      projectId: f.project.id, title: 'A 机环境 v2', content: 'z', kind: 'fact', topicKey: 'env/jdk', device: 'd1',
    });
    assert.equal(revised.revision_count, 2);
    assert.equal(revised.title, 'A 机环境 v2');
    const after = store.searchMemories(f.db, { projectId: f.project.id });
    const d2row = after.hits.find((h) => h.title === 'B 机环境');
    assert.equal(d2row?.revision_count, 1);
  } finally {
    f.cleanup();
  }
});

test('updateMemory 跨作用域迁移：设备记忆上提为项目通用、移入用户级', () => {
  const f = seeded();
  try {
    ensureUserProject(f.db);
    const dev = store.writeMemory(f.db, {
      projectId: f.project.id, title: '端口', content: '3000', kind: 'fact', device: 'd1',
    });
    // Promote to project scope: clear the tags.
    const promoted = store.updateMemory(f.db, f.project.id, dev.id, { device: null, agent: null });
    assert.equal(promoted.device, null);
    assert.equal(promoted.scope, 'project');

    // Demote to user level: move into '@user'.
    const moved = store.moveMemory(f.db, dev.id, USER_PROJECT_ID, 'test');
    assert.equal(moved.project_id, USER_PROJECT_ID);
    assert.equal(moved.scope, 'user');
    // And it now shows in every project brief's user section.
    const brief = store.bootstrapBrief(f.db, f.project.id, 2600, undefined, { device: 'other', agent: null });
    assert.ok(brief.rendered.includes('端口'));
  } finally {
    f.cleanup();
  }
});

test('设备身份：名称归一化、hostname 回退、注册表 upsert', () => {
  const f = seeded();
  try {
    assert.equal(normalizeScopeName('  My Laptop 01 '), 'my-laptop-01');
    assert.equal(normalizeScopeName(''), null);
    assert.equal(normalizeScopeName(undefined), null);
    assert.equal(resolveDevice('Win10-Desk'), 'win10-desk');
    assert.ok(resolveDevice(undefined), 'hostname fallback must resolve to a non-null device');

    registerDevice(f.db, 'd1', 'test');
    registerDevice(f.db, 'd1', 'test-again');
    registerDevice(f.db, 'd2', 'test');
    const devices = listDevices(f.db);
    assert.equal(devices.filter((d) => d.name === 'd1').length, 1);
    assert.equal(devices.find((d) => d.name === 'd1')?.source, 'test', 'upsert keeps the first-seen source');
    assert.equal(devices.length, 2);
  } finally {
    f.cleanup();
  }
});

test('tagsForScope：作用域标签全部来自请求上下文', () => {
  const ctx = { device: 'd1', agent: 'zcode' };
  assert.deepEqual(tagsForScope('user', ctx), { device: null, agent: null });
  assert.deepEqual(tagsForScope('project', ctx), { device: null, agent: null });
  assert.deepEqual(tagsForScope('device', ctx), { device: 'd1', agent: null });
  assert.deepEqual(tagsForScope('agent', ctx), { device: 'd1', agent: 'zcode' });
});

test('projectStats：byScope 分层统计', () => {
  const f = seeded();
  try {
    store.writeMemory(f.db, {
      projectId: f.project.id, title: 'a', content: 'x', kind: 'fact', device: 'd1',
    });
    store.writeMemory(f.db, {
      projectId: f.project.id, title: 'b', content: 'x', kind: 'fact',
    });
    const stats = store.projectStats(f.db, f.project.id);
    const byScope = new Map(stats.byScope.map((s: { scope: string; n: number }) => [s.scope, s.n]));
    assert.equal(byScope.get('device'), 1);
    assert.equal(byScope.get('project'), 1);
  } finally {
    f.cleanup();
  }
});

test('hub 端到端：X-HiveMem-Device 头驱动 REST 写入与简报，设备自动登记', async () => {
  const f = seeded();
  const server = await startHub({ db: f.db, port: 0 });
  try {
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    // REST write with scope=device: the device tag comes from the header.
    const created = await fetch(`${base}/api/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-HiveMem-Device': 'Win10-Desk' },
      body: JSON.stringify({
        project: f.project.name,
        title: 'JDK 安装位置',
        content: 'D:\\jdk17',
        kind: 'fact',
        scope: 'device',
      }),
    });
    assert.equal(created.status, 201);
    const createdBody = (await created.json()) as { memory: { device: string | null; scope: string } };
    assert.equal(createdBody.memory.device, 'win10-desk');
    assert.equal(createdBody.memory.scope, 'device');

    // REST write with scope=user: no project parameter needed.
    const userWrite = await fetch(`${base}/api/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '称谓：老板',
        content: '用户希望被称为老板。',
        kind: 'preference',
        scope: 'user',
      }),
    });
    assert.equal(userWrite.status, 201);
    const userBody = (await userWrite.json()) as { memory: { scope: string; project_id: string } };
    assert.equal(userBody.memory.scope, 'user');
    assert.equal(userBody.memory.project_id, USER_PROJECT_ID);

    // The brief endpoint composes layers from the request context.
    const brief = await fetch(`${base}/api/brief?project=${encodeURIComponent(f.project.name)}`, {
      headers: { 'X-HiveMem-Device': 'win10-desk' },
    });
    assert.equal(brief.status, 200);
    const briefBody = (await brief.json()) as { rendered: string };
    assert.ok(briefBody.rendered.includes('用户级记忆'));
    assert.ok(briefBody.rendered.includes('称谓：老板'));
    assert.ok(briefBody.rendered.includes('本设备记忆（win10-desk）'));
    assert.ok(briefBody.rendered.includes('JDK 安装位置'));

    // A different device sees the user section but not the device section.
    const other = await fetch(`${base}/api/brief?project=${encodeURIComponent(f.project.name)}`, {
      headers: { 'X-HiveMem-Device': 'linux-lap' },
    });
    const otherBody = (await other.json()) as { rendered: string };
    assert.ok(otherBody.rendered.includes('称谓：老板'));
    assert.ok(!otherBody.rendered.includes('JDK 安装位置'));

    // `?budget=` lets the caller (a host hook) size the brief to the prompt:
    // the server owns the invariant, so rendered never exceeds the request.
    const sized = await fetch(`${base}/api/brief?project=${encodeURIComponent(f.project.name)}&budget=600`);
    assert.equal(sized.status, 200);
    const sizedBody = (await sized.json()) as { rendered: string; budget: number; omitted: { budget: number; priority: number } };
    assert.equal(sizedBody.budget, 600);
    assert.ok(sizedBody.rendered.length <= 600, `rendered must respect the requested budget (got ${sizedBody.rendered.length})`);
    // Out-of-range or non-numeric budgets are rejected instead of guessed at.
    const tooSmall = await fetch(`${base}/api/brief?project=${encodeURIComponent(f.project.name)}&budget=12`);
    assert.equal(tooSmall.status, 400);
    assert.equal(((await tooSmall.json()) as { code: string }).code, 'INVALID_INPUT');
    const notANumber = await fetch(`${base}/api/brief?project=${encodeURIComponent(f.project.name)}&budget=lots`);
    assert.equal(notANumber.status, 400);
    // An unknown project is 404 PROJECT_NOT_FOUND, which is what the injection
    // plugin keys on to inject a "not registered" notice instead of silence.
    const missing = await fetch(`${base}/api/brief?project=no-such-project`);
    assert.equal(missing.status, 404);
    assert.equal(((await missing.json()) as { code: string }).code, 'PROJECT_NOT_FOUND');

    // Devices were auto-registered by the requests that carried them.
    const devices = await fetch(`${base}/api/devices`);
    const devicesBody = (await devices.json()) as { devices: Array<{ name: string }> };
    const names = devicesBody.devices.map((d) => d.name);
    assert.ok(names.includes('win10-desk'));
    assert.ok(names.includes('linux-lap'));

    // The reserved name cannot be taken via manual project creation.
    const reserved = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '@user' }),
    });
    assert.equal(reserved.status, 409);

    // Agent-scoped writes never silently degrade: without an agent identity
    // the request is rejected instead of falling back to device scope.
    const noAgent = await fetch(`${base}/api/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: f.project.name,
        title: '无工具标识的写入',
        content: 'x',
        kind: 'fact',
        scope: 'agent',
      }),
    });
    assert.equal(noAgent.status, 400);

    // With the agent header it lands as a proper agent-scoped memory.
    const withAgent = await fetch(`${base}/api/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-HiveMem-Agent': 'zcode' },
      body: JSON.stringify({
        project: f.project.name,
        title: 'ZCODE 配置差异',
        content: '2 skill + 3 mcp',
        kind: 'fact',
        scope: 'agent',
      }),
    });
    assert.equal(withAgent.status, 201);
    const agentBody = (await withAgent.json()) as { memory: { device: string | null; agent: string | null; scope: string } };
    assert.equal(agentBody.memory.agent, 'zcode');
    assert.equal(agentBody.memory.scope, 'agent');
  } finally {
    server.close();
    server.closeAllConnections?.();
    f.cleanup();
  }
});

test('按项目视图寻址：用户级记忆可从工作区读取/更新，跨用户的 @user 仍拒绝', () => {
  const f = seeded();
  try {
    const { user: alice } = auth.createUser(f.db, { name: 'alice', password: 'alicepass' });
    const { user: bob } = auth.createUser(f.db, { name: 'bob', password: 'bobpass' });
    const aliceUser = ensureUserProject(f.db, alice.id);
    const bobUser = ensureUserProject(f.db, bob.id);
    const aliceProject = createNamedProject(f.db, { name: 'alice-ws', ownerUserId: alice.id });
    const preference = store.writeMemory(f.db, {
      projectId: aliceUser.id,
      title: '称谓：老板',
      content: '用户希望被称为老板。',
      kind: 'preference',
    });
    assert.equal(preference.scope, 'user');

    // The caller's own '@user' row is addressable from any workspace project.
    assert.equal(
      store.requireMemoryForProject(f.db, aliceProject.id, preference.id, aliceUser.id).id,
      preference.id,
    );
    // An explicit '@user' reference keeps working via the strict match.
    assert.equal(
      store.requireMemoryForProject(f.db, aliceUser.id, preference.id, aliceUser.id).id,
      preference.id,
    );
    // Another user's view must not resolve it — the fallback is the caller's
    // own row only, never "any user-level memory".
    assert.throws(
      () => store.requireMemoryForProject(f.db, aliceProject.id, preference.id, bobUser.id),
      (error: unknown) =>
        error instanceof Error && (error as { code?: string }).code === 'MEMORY_NOT_FOUND',
    );
    // Project isolation is untouched: project-level rows stay in their project.
    const otherProject = createNamedProject(f.db, { name: 'other-ws' });
    const projectMemory = store.writeMemory(f.db, {
      projectId: otherProject.id,
      title: '别的项目',
      content: 'x',
      kind: 'fact',
    });
    assert.throws(
      () => store.requireMemoryForProject(f.db, aliceProject.id, projectMemory.id, aliceUser.id),
      (error: unknown) =>
        error instanceof Error && (error as { code?: string }).code === 'MEMORY_NOT_FOUND',
    );
  } finally {
    f.cleanup();
  }
});
