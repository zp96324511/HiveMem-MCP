import test from 'node:test';
import assert from 'node:assert/strict';
import { startHub } from '../src/http.js';
import { ensureProject } from '../src/projects.js';
import * as store from '../src/store.js';
// The plugin is plain ESM with no build step; tsx resolves it like any other module.
import { apply as applyBriefPlugin } from '../dsh-plugin/lib/index.js';
import { fixture } from './helpers.js';

/**
 * Integration test for the DSH pre-step injection plugin: a real hub, a real
 * brief, and a fake host context. This is the closest thing to "does a fresh
 * session actually receive memory without calling a tool" that can run in CI —
 * it drives the same two surfaces DSH drives (`agent/pre-step` and the
 * `systemPrompt` context registry) instead of re-implementing the logic.
 */

interface PreStep {
  agent: { session: unknown };
  turn: number;
  step: number;
  signal?: AbortSignal;
}
type Handler = (payload: PreStep, next: () => Promise<{ kind: 'enter'; messages: unknown[] }>) => Promise<unknown>;
interface Contribution {
  name: string;
  order: number;
  text: () => string;
}

interface SessionLike {
  header?: { cwd?: string };
}

/**
 * A fake host context. Two details mirror real cordis on purpose:
 *  - reading an un-injected service (`ctx.workingDirectory`) THROWS, so the
 *    plugin must go through the injection-free `ctx.reflect` read;
 *  - a service that is not mounted yet is simply absent, which is exactly the
 *    first-step situation where the session header is the only correct source.
 * The previous fake exposed `ctx.workingDirectory` directly, which hid a real
 * bug: on a live host the project name came from the host's process directory.
 */
function fakeHost(cwd: string, options: { withService?: boolean; withHeader?: boolean } = {}) {
  const handlers: Array<{ event: string; fn: Handler }> = [];
  let contribution: Contribution | null = null;
  const withService = options.withService ?? true;
  const withHeader = options.withHeader ?? true;
  const session: SessionLike = withHeader ? { header: { cwd } } : {};
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    on: (event: string, fn: Handler) => {
      handlers.push({ event, fn });
      return () => {};
    },
    systemPrompt: {
      context: (c: Contribution) => {
        contribution = c;
        return () => {};
      },
    },
    // cordis: `cannot get property "workingDirectory" without inject`.
    get workingDirectory() {
      throw new Error('cannot get property "workingDirectory" without inject');
    },
    reflect: {
      get: (name: string) =>
        name === 'workingDirectory' && withService
          ? { get: (s: SessionLike) => s?.header?.cwd ?? cwd }
          : undefined,
    },
  };
  return {
    ctx,
    session,
    step: (payload: Partial<PreStep> = {}) => {
      const handler = handlers.find((h) => h.event === 'agent/pre-step');
      assert.ok(handler, 'plugin must register an agent/pre-step listener');
      return handler.fn(
        { agent: { session }, turn: 1, step: 1, ...payload },
        async () => ({ kind: 'enter' as const, messages: [] }),
      );
    },
    text: () => (contribution ? contribution.text() : ''),
    contribution: () => contribution,
  };
}

async function closeServer(server: { close: (cb: () => void) => void }): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test('前置注入：pre-step 之后，systemPrompt 上下文里已有该项目的记忆（无需调工具）', async () => {
  const f = fixture();
  const project = ensureProject(f.db, f.projDir, { withMarker: false });
  store.writeMemory(f.db, {
    projectId: project.id,
    title: '部署位置在 1Panel',
    content: '生产 hub 跑在 hivemem.zpzp.xyz，用 OpenResty 反代。',
    kind: 'fact',
  });
  const server = await startHub({ db: f.db, port: 0 });
  const port = (server.address() as { port: number }).port;
  try {
    const host = fakeHost(f.projDir);
    applyBriefPlugin(host.ctx, { baseUrl: `http://127.0.0.1:${port}`, ttlMs: 0 });

    // Before the first step there is nothing to inject.
    assert.equal(host.text(), '');
    const contribution = host.contribution();
    assert.ok(contribution);
    assert.equal(contribution.name, 'hivemem:brief');

    const decision = await host.step();
    assert.deepEqual(decision, { kind: 'enter', messages: [] }, 'the plugin must pass the step through');

    const injected = host.text();
    assert.match(injected, /HiveMem 项目简报/);
    assert.match(injected, new RegExp(`project=${project.name}`));
    assert.match(injected, /部署位置在 1Panel/);
    assert.match(injected, /当前用户指示始终优先/, 'memories are background, not instructions');
  } finally {
    await closeServer(server);
    f.cleanup();
  }
});

test('前置注入：hub 不可达时不报错、不注入，也不阻断这一轮', async () => {
  const f = fixture();
  ensureProject(f.db, f.projDir, { withMarker: false });
  // Port 1 is closed: the read must fail fast and fail open.
  const host = fakeHost(f.projDir);
  applyBriefPlugin(host.ctx, { baseUrl: 'http://127.0.0.1:1', timeoutMs: 300, ttlMs: 0 });
  try {
    const decision = await host.step();
    assert.deepEqual(decision, { kind: 'enter', messages: [] });
    assert.equal(host.text(), '', 'a failed read injects nothing');
  } finally {
    f.cleanup();
  }
});

test('前置注入：刷新失败时保留上一次成功的简报（stale-ok）', async () => {
  const f = fixture();
  const project = ensureProject(f.db, f.projDir, { withMarker: false });
  store.writeMemory(f.db, { projectId: project.id, title: '先拿到这条', content: 'x', kind: 'fact' });
  const server = await startHub({ db: f.db, port: 0 });
  const port = (server.address() as { port: number }).port;
  const host = fakeHost(f.projDir);
  applyBriefPlugin(host.ctx, { baseUrl: `http://127.0.0.1:${port}`, ttlMs: 0, timeoutMs: 500 });
  try {
    await host.step();
    assert.match(host.text(), /先拿到这条/);

    await closeServer(server);
    const decision = await host.step({ turn: 2, step: 1 });
    assert.deepEqual(decision, { kind: 'enter', messages: [] }, 'a dead hub must not reject the step');
    assert.match(host.text(), /先拿到这条/, 'the last good brief stays in the prompt');
  } finally {
    f.cleanup();
  }
});

test('前置注入：作用域头让本设备/本工具的记忆真正出现（而不是被静默丢掉）', async () => {
  const f = fixture();
  const project = ensureProject(f.db, f.projDir, { withMarker: false });
  store.writeMemory(f.db, {
    projectId: project.id,
    title: '项目级：用 node:sqlite',
    content: '项目层决策。',
    kind: 'decision',
  });
  store.writeMemory(f.db, {
    projectId: project.id,
    title: 'JDK 装在 D 盘',
    content: '本机 JDK 路径 D:\\jdk。',
    kind: 'fact',
    device: 'win10-desk',
  });
  store.writeMemory(f.db, {
    projectId: project.id,
    title: 'DSH 插件走 patch',
    content: '本工具配置。',
    kind: 'fact',
    device: 'win10-desk',
    agent: 'dsh',
  });
  const server = await startHub({ db: f.db, port: 0 });
  const port = (server.address() as { port: number }).port;
  try {
    const host = fakeHost(f.projDir);
    applyBriefPlugin(host.ctx, {
      baseUrl: `http://127.0.0.1:${port}`,
      ttlMs: 0,
      device: 'win10-desk',
      agent: 'dsh',
    });
    await host.step();
    const injected = host.text();
    assert.match(injected, /用 node:sqlite/);
    assert.match(injected, /本设备记忆（win10-desk）/);
    assert.match(injected, /JDK 装在 D 盘/);
    assert.match(injected, /本工具记忆（dsh）/);
    assert.match(injected, /DSH 插件走 patch/);
  } finally {
    await closeServer(server);
    f.cleanup();
  }
});

test('前置注入：未注册项目注入一行可见提示，模型下一步就能补注册', async () => {
  const f = fixture();
  // The directory is not registered on the hub: /api/brief answers 404
  // PROJECT_NOT_FOUND. Injection must say so instead of staying silent.
  const server = await startHub({ db: f.db, port: 0 });
  const port = (server.address() as { port: number }).port;
  try {
    const host = fakeHost(f.projDir);
    applyBriefPlugin(host.ctx, { baseUrl: `http://127.0.0.1:${port}`, ttlMs: 0 });
    const decision = await host.step();
    assert.deepEqual(decision, { kind: 'enter', messages: [] }, 'a missing project must not reject the step');
    const injected = host.text();
    assert.match(injected, /尚未注册/);
    assert.match(injected, /memory_bootstrap\(project="/);
    assert.match(injected, /HTTP 模式会自动创建/);
  } finally {
    await closeServer(server);
    f.cleanup();
  }
});

test('前置注入：简报超出 maxChars 时降级为提示，不裁剪正文', async () => {
  const f = fixture();
  const project = ensureProject(f.db, f.projDir, { withMarker: false });
  for (let i = 0; i < 6; i += 1) {
    store.writeMemory(f.db, {
      projectId: project.id,
      title: `条目 ${i}`,
      content: `${'内容'.repeat(60)} ${i}`,
      kind: 'decision',
    });
  }
  const server = await startHub({ db: f.db, port: 0 });
  const port = (server.address() as { port: number }).port;
  try {
    // 600 − header (~130) is below the server's 512 minimum budget, so the
    // server must render more than the host ceiling allows: the plugin's only
    // honest options are "skip and say so" or "clip silently". It says so.
    const host = fakeHost(f.projDir);
    applyBriefPlugin(host.ctx, { baseUrl: `http://127.0.0.1:${port}`, ttlMs: 0, maxChars: 520 });
    await host.step();
    const injected = host.text();
    assert.match(injected, /超出注入预算/);
    assert.match(injected, /memory_bootstrap/);
    assert.ok(!injected.includes('## HiveMem 项目简报'), 'the oversize path skips the body, not part of it');
  } finally {
    await closeServer(server);
    f.cleanup();
  }
});

test('前置注入：分辨率来自 ctx.reflect 的服务，而不是未注入的 ctx.workingDirectory', async () => {
  const f = fixture();
  const project = ensureProject(f.db, f.projDir, { withMarker: false });
  store.writeMemory(f.db, { projectId: project.id, title: '服务路径可用', content: 'x', kind: 'fact' });
  const server = await startHub({ db: f.db, port: 0 });
  const port = (server.address() as { port: number }).port;
  try {
    const host = fakeHost(f.projDir);
    applyBriefPlugin(host.ctx, { baseUrl: `http://127.0.0.1:${port}`, ttlMs: 0 });
    await host.step();
    assert.match(host.text(), new RegExp(`project=${project.name}`), 'the service read must win over the process directory');
  } finally {
    await closeServer(server);
    f.cleanup();
  }
});

test('前置注入：工作目录服务缺席时用会话 header 的 cwd（首步不能退到宿主进程目录）', async () => {
  const f = fixture();
  const project = ensureProject(f.db, f.projDir, { withMarker: false });
  store.writeMemory(f.db, { projectId: project.id, title: 'header 兜底', content: 'x', kind: 'fact' });
  const server = await startHub({ db: f.db, port: 0 });
  const port = (server.address() as { port: number }).port;
  try {
    // withService: false models the very first step, before the projection
    // handle exists. Without the header fallback the plugin would derive the
    // project from process.cwd() and inject a brief for the wrong project.
    const host = fakeHost(f.projDir, { withService: false });
    applyBriefPlugin(host.ctx, { baseUrl: `http://127.0.0.1:${port}`, ttlMs: 0 });
    await host.step();
    assert.match(host.text(), new RegExp(`project=${project.name}`));
    assert.match(host.text(), /header 兜底/);
  } finally {
    await closeServer(server);
    f.cleanup();
  }
});

test('前置注入：没有任何目录来源时，未注册提示里写明项目名取自哪个目录', async () => {
  const f = fixture();
  const server = await startHub({ db: f.db, port: 0 });
  const port = (server.address() as { port: number }).port;
  try {
    const host = fakeHost(f.projDir, { withService: false, withHeader: false });
    applyBriefPlugin(host.ctx, { baseUrl: `http://127.0.0.1:${port}`, ttlMs: 0 });
    await host.step();
    const injected = host.text();
    assert.match(injected, /尚未注册/);
    // The directory is spelled out so a wrong project name is diagnosable from
    // the prompt alone (that is how the "win10" misresolution surfaced).
    assert.match(injected, /项目名取自会话目录：/);
  } finally {
    await closeServer(server);
    f.cleanup();
  }
});

test('前置注入：enabled=false 时完全不注册任何钩子', () => {
  const host = fakeHost('C:\\data\\projects\\HiveMem-MCP');
  applyBriefPlugin(host.ctx, { enabled: false });
  assert.equal(host.contribution(), null);
  assert.throws(() => host.step(), /plugin must register an agent\/pre-step listener/);
});
