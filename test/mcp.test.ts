import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as auth from '../src/auth.js';
import { createMcpServer } from '../src/mcp.js';
import { createNamedProject, USER_PROJECT_ID } from '../src/projects.js';
import * as store from '../src/store.js';
import { fixture } from './helpers.js';

interface ToolPayload {
  error?: { code: string; message: string };
  [key: string]: unknown;
}

async function connectedPair() {
  const f = fixture();
  const server = createMcpServer({ db: f.db, cwd: f.projDir, httpMode: false, agent: 'test-agent' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  await client.connect(clientTransport);
  return { f, client, close: async () => { await client.close(); await server.close(); f.cleanup(); } };
}

const payloadOf = (result: unknown): ToolPayload => {
  const r = result as { content?: Array<{ type: string; text: string }> };
  assert.ok(r.content?.[0]?.text, 'tool result must carry text content');
  return JSON.parse(r.content[0].text) as ToolPayload;
};

test('MCP 往返：bootstrap → write → search → read → archive', async () => {
  const { client, close } = await connectedPair();
  try {
    // bootstrap on a fresh project: empty brief, project auto-registered
    const boot = payloadOf(await client.callTool({ name: 'memory_bootstrap', arguments: {} }));
    assert.ok(boot.project?.id);
    assert.equal(typeof boot.rendered, 'string');

    // write
    const write = payloadOf(await client.callTool({
      name: 'memory_write',
      arguments: {
        title: '测试决策：采用 SQLite',
        content: '理由：零运维、单文件、跨平台。',
        kind: 'decision',
        tags: ['storage'],
        importance: 0.9,
        pinned: true,
      },
    }));
    assert.ok(write.memory?.id?.startsWith('mem_'));
    const memoryId = write.memory.id as string;

    // search finds it (Chinese query)
    const search = payloadOf(await client.callTool({
      name: 'memory_search',
      arguments: { query: 'SQLite' },
    }));
    assert.ok(search.hits?.length >= 1);
    assert.equal(search.hits[0].id, memoryId);

    // read full content
    const read = payloadOf(await client.callTool({
      name: 'memory_read',
      arguments: { id: memoryId },
    }));
    assert.equal(read.memory?.content, '理由：零运维、单文件、跨平台。');

    // archive then default search hides it
    await client.callTool({ name: 'memory_archive', arguments: { id: memoryId } });
    const after = payloadOf(await client.callTool({
      name: 'memory_search',
      arguments: { query: 'SQLite' },
    }));
    assert.equal(after.hits?.length, 0);

    // stats lists the project
    const stats = payloadOf(await client.callTool({ name: 'memory_stats', arguments: {} }));
    assert.ok(stats.projects?.length >= 1);
  } finally {
    await close();
  }
});

test('MCP 错误：未知项目返回结构化错误与项目列表', async () => {
  const { client, close } = await connectedPair();
  try {
    const result = await client.callTool({
      name: 'memory_search',
      arguments: { project: '不存在的项目', query: 'x' },
    });
    assert.ok((result as { isError?: boolean }).isError);
    const payload = payloadOf(result);
    assert.equal(payload.error?.code, 'PROJECT_NOT_FOUND');
    const detail = (payload as { error?: { detail?: { projects?: unknown[] } } }).error?.detail;
    assert.ok(Array.isArray(detail?.projects));
  } finally {
    await close();
  }
});

test('HTTP 模式：project 在 schema 中必填（memory_write 的 scope=user 例外）', async () => {
  const f = fixture();
  try {
    const server = createMcpServer({ db: f.db, cwd: f.projDir, httpMode: true });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '0.0.1' });
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    const requiredOf = (name: string): string[] => {
      const tool = tools.find((candidate) => candidate.name === name);
      return (tool?.inputSchema as { required?: string[] } | undefined)?.required ?? [];
    };
    for (const name of [
      'memory_bootstrap',
      'memory_search',
      'memory_index',
      'memory_read',
      'memory_update',
      'memory_archive',
      'memory_review',
      'memory_stats',
    ]) {
      assert.ok(requiredOf(name).includes('project'), `${name} 必须把 project 标为必填`);
    }
    assert.equal(
      requiredOf('memory_write').includes('project'),
      false,
      'memory_write 保留 scope=user 的省略例外',
    );

    // 缺 project 在参数校验阶段就被拒绝；不同 SDK 版本可能抛错或返回 isError。
    try {
      const result = await client.callTool({ name: 'memory_bootstrap', arguments: {} });
      assert.ok((result as { isError?: boolean }).isError, 'missing project must fail');
    } catch (error) {
      assert.match(String((error as Error).message), /required|Invalid arguments|-32602/i);
    }

    await client.close();
    await server.close();
  } finally {
    f.cleanup();
  }
});

test('HTTP 模式：bootstrap 新项目名自动创建，写工具保持严格', async () => {
  const f = fixture();
  try {
    const server = createMcpServer({ db: f.db, cwd: f.projDir, httpMode: true, agent: 'test-agent' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '0.0.1' });
    await client.connect(clientTransport);

    // 1) Bootstrap with a brand-new project name auto-creates it, with the
    //    created flag + pre-existing project list for in-conversation typo checks.
    const boot = payloadOf(await client.callTool({
      name: 'memory_bootstrap',
      arguments: { project: 'brand-new-proj' },
    }));
    assert.equal(boot.created, true);
    assert.equal(boot.project?.name, 'brand-new-proj');
    assert.ok(Array.isArray(boot.registered_projects));

    // 2) Writes now succeed against the auto-created project.
    const write = payloadOf(await client.callTool({
      name: 'memory_write',
      arguments: { project: 'brand-new-proj', title: 't', content: 'c', kind: 'fact' },
    }));
    assert.ok(write.memory?.id);

    // 3) Re-bootstrapping the same name resolves normally — no created flag.
    const boot2 = payloadOf(await client.callTool({
      name: 'memory_bootstrap',
      arguments: { project: 'brand-new-proj' },
    }));
    assert.equal(boot2.created, undefined);

    // 4) Write/search with an unknown name still fail loudly (no silent
    //    auto-create outside bootstrap — typo fragmentation guard).
    const badWrite = await client.callTool({
      name: 'memory_write',
      arguments: { project: 'typo-proj', title: 't', content: 'c', kind: 'fact' },
    });
    assert.ok((badWrite as { isError?: boolean }).isError);
    assert.equal(payloadOf(badWrite).error?.code, 'PROJECT_NOT_FOUND');

    // 5) Path-shaped references never auto-create: the hub cannot derive a
    //    canonical identity from a client-side path it cannot see.
    const badPath = await client.callTool({
      name: 'memory_bootstrap',
      arguments: { project: 'C:\\data\\projects\\never-registered' },
    });
    assert.ok((badPath as { isError?: boolean }).isError);
    assert.equal(payloadOf(badPath).error?.code, 'PROJECT_NOT_FOUND');

    await client.close();
    await server.close();
  } finally {
    f.cleanup();
  }
});

test('HTTP 模式多用户：bootstrap 自动创建的项目归属创建者', async () => {
  const f = fixture();
  try {
    const { user: alice } = auth.createUser(f.db, { name: 'alice', password: 'alicepass' });
    const server = createMcpServer({
      db: f.db,
      cwd: f.projDir,
      httpMode: true,
      auth: { userId: alice.id, name: alice.name, role: 'user', via: 'token' },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '0.0.1' });
    await client.connect(clientTransport);

    const boot = payloadOf(await client.callTool({
      name: 'memory_bootstrap',
      arguments: { project: 'alice-workspace' },
    }));
    assert.equal(boot.created, true);
    const owner = f.db
      .prepare('SELECT owner_user_id FROM projects WHERE id = ?')
      .get(boot.project.id) as { owner_user_id: string };
    assert.equal(owner.owner_user_id, alice.id);

    // The reserved name is never auto-created.
    const reserved = await client.callTool({
      name: 'memory_bootstrap',
      arguments: { project: 'x' },
    });
    assert.ok(!(reserved as { isError?: boolean }).isError);

    await client.close();
    await server.close();
  } finally {
    f.cleanup();
  }
});

test('MCP：memory_index 枚举分页 + 全量索引 resource', async () => {
  const { client, close } = await connectedPair();
  try {
    for (let i = 0; i < 3; i++) {
      const w = payloadOf(await client.callTool({
        name: 'memory_write',
        arguments: { title: `枚举目标-${i}`, content: `内容 ${i}`, kind: 'fact' },
      }));
      assert.ok(w.memory?.id, `write ${i} failed`);
    }

    const idx = payloadOf(await client.callTool({ name: 'memory_index', arguments: { limit: 2 } }));
    const project = idx.project as { id: string };
    assert.ok(project.id);
    assert.equal(idx.total, 3, 'total is the match count, not the page size');
    assert.equal((idx.entries as unknown[]).length, 2);
    assert.equal(idx.next_offset, 2);
    assert.ok(String(idx.guidance).includes('offset=2'), 'guidance tells the agent how to page');

    const lastPage = payloadOf(await client.callTool({
      name: 'memory_index',
      arguments: { offset: 2, limit: 2 },
    }));
    assert.equal((lastPage.entries as unknown[]).length, 1);
    assert.equal(lastPage.next_offset, null);

    const res = await client.readResource({ uri: `memory://projects/${project.id}/index` });
    const text = res.contents[0].text as string;
    assert.ok(text.includes('记忆索引'), 'index resource renders a title');
    assert.ok(text.includes('枚举目标-0'), 'index resource lists entries');
    assert.ok(text.includes('3 条 active'), 'index resource states the total');
  } finally {
    await close();
  }
});

test('memory_bootstrap 接受 budget：服务端保证 rendered ≤ budget，并报出省略原因', async () => {
  const { f, client, close } = await connectedPair();
  try {
    // Enough distinct sections that a small budget must drop something.
    for (let i = 0; i < 12; i++) {
      await client.callTool({
        name: 'memory_write',
        arguments: {
          title: `决策 ${i}`,
          content: `第 ${i} 条决策的理由写得很长，用来占满预算：`.repeat(4),
          kind: 'decision',
        },
      });
    }
    const tight = payloadOf(await client.callTool({
      name: 'memory_bootstrap',
      arguments: { budget: 600 },
    }));
    const rendered = String(tight.rendered);
    assert.ok(rendered.length <= 600, `rendered ${rendered.length} must stay within the requested budget`);
    assert.equal(tight.truncated, true);
    const omitted = tight.omitted as { budget: number; priority: number };
    assert.equal(omitted.budget + omitted.priority, Number(tight.total) - Number(tight.shown));

    const roomy = payloadOf(await client.callTool({
      name: 'memory_bootstrap',
      arguments: { budget: 8000 },
    }));
    assert.ok(String(roomy.rendered).length > rendered.length, 'a larger budget yields a longer brief');

    // Out-of-range budgets are rejected by the tool schema, not silently clamped.
    const rejected = await client.callTool({ name: 'memory_bootstrap', arguments: { budget: 100 } });
    assert.ok((rejected as { isError?: boolean }).isError);
  } finally {
    await close();
  }
});

test('用户级记忆跨项目寻址：workspace 项目可按 id read/update/archive，项目记忆仍隔离', async () => {
  const { f, client, close } = await connectedPair();
  try {
    // Bootstrap registers the workspace project used by the stdio default.
    const boot = payloadOf(await client.callTool({ name: 'memory_bootstrap', arguments: {} }));
    assert.ok(boot.project?.id);

    // scope=user lands in the reserved '@user' project, not the workspace one.
    const write = payloadOf(await client.callTool({
      name: 'memory_write',
      arguments: { title: '跨项目偏好', content: '所有会话用中文。', kind: 'preference', scope: 'user' },
    }));
    const userId = write.memory.id as string;
    assert.equal(write.memory.scope, 'user');
    assert.equal(write.memory.project_id, USER_PROJECT_ID);

    // read through the workspace view resolves the user-level row — the bug:
    // it used to throw MEMORY_NOT_FOUND because the project id did not match.
    const read = payloadOf(await client.callTool({ name: 'memory_read', arguments: { id: userId } }));
    assert.equal(read.memory.id, userId);
    assert.equal(read.memory.scope, 'user');

    // update mutates the row's real project (not the workspace) and versions up.
    const updated = payloadOf(await client.callTool({
      name: 'memory_update',
      arguments: { id: userId, content: '所有会话用中文（已更新）。' },
    }));
    assert.equal(updated.memory.content, '所有会话用中文（已更新）。');
    assert.equal(updated.memory.project_id, USER_PROJECT_ID);
    assert.equal(updated.memory.version, 2);

    // archive works from the same view.
    const archived = payloadOf(await client.callTool({
      name: 'memory_archive',
      arguments: { id: userId },
    }));
    assert.equal(archived.memory.status, 'archived');

    // Project isolation is untouched: another project's row is still not addressable.
    const other = createNamedProject(f.db, { name: 'other-project' });
    const foreign = store.writeMemory(f.db, {
      projectId: other.id,
      title: '别的项目',
      content: 'x',
      kind: 'fact',
    });
    const missing = payloadOf(await client.callTool({ name: 'memory_read', arguments: { id: foreign.id } }));
    assert.equal(missing.error?.code, 'MEMORY_NOT_FOUND');
  } finally {
    await close();
  }
});
