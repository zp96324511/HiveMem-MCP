import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { startHub } from '../src/http.js';
import { ensureProject } from '../src/projects.js';
import { createMcpServer } from '../src/mcp.js';
import * as store from '../src/store.js';
import { HiveMemError } from '../src/util.js';
import { fixture } from './helpers.js';

/**
 * v0.4 write-path guarantees:
 *  - optimistic concurrency (version CAS) on every mutation
 *  - old bodies addressable by version, not buried in an audit JSON blob
 *  - typed evidence locators that survive topic revisions
 */

function seeded() {
  const f = fixture();
  const project = ensureProject(f.db, f.projDir, { withMarker: false });
  return { ...f, project };
}

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof HiveMemError, `expected HiveMemError, got ${String(error)}`);
    return error.code;
  }
  assert.fail('expected a thrown HiveMemError');
};

// ---------------------------------------------------------------------------
// 1. optimistic concurrency
// ---------------------------------------------------------------------------

test('CAS：version 从 1 起，陈旧 expectedVersion 被拒且不覆盖内容', () => {
  const f = seeded();
  try {
    const created = store.writeMemory(f.db, {
      projectId: f.project.id,
      title: '并发目标',
      content: '第一版',
      kind: 'fact',
    });
    assert.equal(created.version, 1);

    const v2 = store.updateMemory(f.db, f.project.id, created.id, {
      content: '第二版',
      expectedVersion: 1,
    });
    assert.equal(v2.version, 2);
    assert.equal(v2.content, '第二版');

    // A writer that read v1 and writes late must lose, loudly.
    try {
      store.updateMemory(f.db, f.project.id, created.id, { content: '迟到的覆盖', expectedVersion: 1 });
      assert.fail('stale write must throw');
    } catch (error) {
      assert.ok(error instanceof HiveMemError);
      assert.equal(error.code, 'REVISION_CONFLICT');
      const detail = error.detail as { expected_version: number; current_version: number };
      assert.equal(detail.expected_version, 1);
      assert.equal(detail.current_version, 2);
    }
    const live = store.getMemory(f.db, created.id);
    assert.equal(live?.content, '第二版', 'stale write must not overwrite');
    assert.equal(live?.version, 2);

    // Non-positive tokens are caller bugs, not conflicts.
    assert.equal(
      codeOf(() => store.updateMemory(f.db, f.project.id, created.id, { content: 'x', expectedVersion: 0 })),
      'INVALID_INPUT',
    );
  } finally {
    f.cleanup();
  }
});

test('CAS：topic_key 原地修订同样受 expectedVersion 保护', () => {
  const f = seeded();
  try {
    const base = {
      projectId: f.project.id,
      kind: 'fact' as const,
      topicKey: 'arch/storage',
    };
    const v1 = store.writeMemory(f.db, { ...base, title: '存储选型', content: 'SQLite' });
    const v2 = store.writeMemory(f.db, {
      ...base,
      title: '存储选型',
      content: 'SQLite + WAL',
      expectedVersion: v1.version,
    });
    assert.equal(v2.id, v1.id);
    assert.equal(v2.revision_count, 2);
    assert.equal(v2.version, 2);

    assert.equal(
      codeOf(() =>
        store.writeMemory(f.db, { ...base, title: '存储选型', content: 'Postgres', expectedVersion: 1 }),
      ),
      'REVISION_CONFLICT',
    );
    assert.equal(store.getMemory(f.db, v1.id)?.content, 'SQLite + WAL');
  } finally {
    f.cleanup();
  }
});

test('CAS：archive 与 delete 也是带版本的 mutation', () => {
  const f = seeded();
  try {
    const m = store.writeMemory(f.db, {
      projectId: f.project.id,
      title: '将归档',
      content: 'x',
      kind: 'fact',
    });
    const archived = store.archiveMemory(f.db, f.project.id, m.id, 'tester', { expectedVersion: 1 });
    assert.equal(archived.status, 'archived');
    assert.equal(archived.version, 2);
    assert.equal(
      codeOf(() => store.archiveMemory(f.db, f.project.id, m.id, 'tester', { expectedVersion: 1 })),
      'REVISION_CONFLICT',
    );
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 2. old versions are addressable
// ---------------------------------------------------------------------------

test('历史可寻址：readMemoryAt 返回旧快照，listRevisions 列出改动', () => {
  const f = seeded();
  try {
    const m = store.writeMemory(f.db, {
      projectId: f.project.id,
      title: '原始标题',
      content: '原始正文',
      kind: 'fact',
      tags: ['a'],
    });
    const v2 = store.updateMemory(f.db, f.project.id, m.id, { title: '新标题', content: '新正文' });
    assert.equal(v2.version, 2);

    const at1 = store.readMemoryAt(f.db, m.id, 1);
    assert.ok(at1, 'version 1 snapshot must exist once v2 was written');
    assert.equal(at1.title, '原始标题');
    assert.equal(at1.content, '原始正文');
    assert.deepEqual(at1.tags, ['a']);
    assert.equal(at1.version, 1);

    const at2 = store.readMemoryAt(f.db, m.id, 2);
    assert.equal(at2?.content, '新正文', 'current version is served from the live row');
    assert.equal(store.readMemoryAt(f.db, m.id, 99), null);

    // A revision row is written when a version is replaced: after one update
    // only v1 is superseded, the live v2 lives in the table itself.
    const revisions = store.listRevisions(f.db, m.id);
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0].version, 1);
    assert.equal(revisions[0].action, 'update');
    assert.equal(revisions[0].title, '原始标题');

    // Deleting a memory must not erase what it used to say: the final state is
    // recorded before the row goes away.
    store.deleteMemory(f.db, f.project.id, m.id, 'tester');
    assert.equal(store.getMemory(f.db, m.id), null);
    assert.equal(store.readMemoryAt(f.db, m.id, 1)?.content, '原始正文');
    assert.equal(store.readMemoryAt(f.db, m.id, 2)?.content, '新正文');
    const afterDelete = store.listRevisions(f.db, m.id);
    assert.deepEqual(
      afterDelete.map((r) => [r.version, r.action]),
      [
        [2, 'delete'],
        [1, 'update'],
      ],
    );
  } finally {
    f.cleanup();
  }
});

test('历史可寻址：move 与 review 也留下版本', () => {
  const f = seeded();
  try {
    const other = ensureProject(f.db, `${f.dir}/other`, { withMarker: false });
    const m = store.writeMemory(f.db, {
      projectId: f.project.id,
      title: '会被搬走',
      content: 'x',
      kind: 'fact',
    });
    const moved = store.moveMemory(f.db, m.id, other.id, 'tester');
    assert.equal(moved.project_id, other.id);
    assert.equal(moved.version, 2);
    assert.equal(store.listRevisions(f.db, m.id)[0].action, 'move');
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 3. evidence
// ---------------------------------------------------------------------------

test('证据链：写入规范化（去重/截断/时间），非法 kind 报错', () => {
  const f = seeded();
  try {
    const m = store.writeMemory(f.db, {
      projectId: f.project.id,
      title: '有据可查',
      content: 'x',
      kind: 'fact',
      evidence: [
        { kind: 'file', locator: ' src/store.ts:120 ' },
        { kind: 'file', locator: 'src/store.ts:120', quote: 'dup' },
        { kind: 'prompt', locator: 'm00053', quote: '开始规划和实施值得抄的 5 个点' },
      ],
    });
    assert.equal(m.evidence.length, 2, 'same kind+locator collapses');
    assert.equal(m.evidence[0].locator, 'src/store.ts:120', 'locator is trimmed');
    assert.ok(m.evidence[0].at, 'observation time defaults to write time');
    assert.equal(m.evidence[1].kind, 'prompt');

    assert.equal(
      codeOf(() =>
        store.writeMemory(f.db, {
          projectId: f.project.id,
          title: '坏证据',
          content: 'x',
          kind: 'fact',
          evidence: [{ kind: 'guess' as 'note', locator: 'x' }],
        }),
      ),
      'INVALID_EVIDENCE',
    );
    assert.equal(
      codeOf(() =>
        store.writeMemory(f.db, {
          projectId: f.project.id,
          title: '空定位',
          content: 'x',
          kind: 'fact',
          evidence: [{ kind: 'note', locator: '   ' }],
        }),
      ),
      'INVALID_EVIDENCE',
    );
  } finally {
    f.cleanup();
  }
});

test('证据链：topic 修订累积证据，update 的 evidence 是替换', () => {
  const f = seeded();
  try {
    const base = { projectId: f.project.id, kind: 'fact' as const, topicKey: 'deploy/target' };
    const v1 = store.writeMemory(f.db, {
      ...base,
      title: '部署目标',
      content: 'k8s',
      evidence: [{ kind: 'prompt', locator: 'm00001' }],
    });
    const v2 = store.writeMemory(f.db, {
      ...base,
      title: '部署目标',
      content: '1Panel + OpenResty',
      evidence: [{ kind: 'url', locator: 'https://hivemem.zpzp.xyz' }],
    });
    assert.deepEqual(
      v2.evidence.map((e) => e.kind),
      ['prompt', 'url'],
      'a revision keeps the lineage of earlier sources',
    );

    const replaced = store.updateMemory(f.db, f.project.id, v1.id, {
      evidence: [{ kind: 'command', locator: 'docker ps' }],
    });
    assert.deepEqual(
      replaced.evidence.map((e) => e.locator),
      ['docker ps'],
      'update is an explicit PATCH over a row the caller is looking at',
    );

    const cleared = store.updateMemory(f.db, f.project.id, v1.id, { evidence: [] });
    assert.deepEqual(cleared.evidence, [], 'an empty list removes wrong locators');
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 4. MCP surface
// ---------------------------------------------------------------------------

interface ToolPayload {
  error?: { code: string; message: string; detail?: Record<string, unknown> };
  [key: string]: any;
}

async function connectedPair() {
  const f = seeded();
  const server = createMcpServer({ db: f.db, cwd: f.projDir, httpMode: false, agent: 'test-agent' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  await client.connect(clientTransport);
  return {
    f,
    client,
    close: async () => {
      await client.close();
      await server.close();
      f.cleanup();
    },
  };
}

const payloadOf = (result: unknown): ToolPayload => {
  const r = result as { content?: Array<{ type: string; text: string }> };
  assert.ok(r.content?.[0]?.text, 'tool result must carry text content');
  return JSON.parse(r.content[0].text) as ToolPayload;
};

test('MCP：memory_read 可读历史版本并列出历史，未知版本报 REVISION_NOT_FOUND', async () => {
  const { client, close } = await connectedPair();
  try {
    const write = payloadOf(await client.callTool({
      name: 'memory_write',
      arguments: {
        title: 'MCP 历史',
        content: 'v1 正文',
        kind: 'fact',
        evidence: [{ kind: 'session', locator: 'dsh/study-win10#m00053' }],
      },
    }));
    const id = write.memory.id as string;
    assert.equal(write.memory.version, 1);
    assert.equal(write.memory.evidence[0].kind, 'session');

    const upd = payloadOf(await client.callTool({
      name: 'memory_update',
      arguments: { id, content: 'v2 正文', expected_version: 1 },
    }));
    assert.equal(upd.memory.version, 2);

    const old = payloadOf(await client.callTool({
      name: 'memory_read',
      arguments: { id, at_version: 1 },
    }));
    assert.equal(old.memory.content, 'v1 正文');
    assert.equal(old.live_version, 2);

    const history = payloadOf(await client.callTool({
      name: 'memory_read',
      arguments: { id, include_history: true },
    }));
    assert.equal(history.history.current_version, 2);
    assert.deepEqual(
      history.history.revisions.map((r: { version: number }) => r.version),
      [1],
      'only superseded versions are listed; the live body is the memory itself',
    );

    const missing = payloadOf(await client.callTool({
      name: 'memory_read',
      arguments: { id, at_version: 42 },
    }));
    assert.equal(missing.error?.code, 'REVISION_NOT_FOUND');
  } finally {
    await close();
  }
});

test('MCP：memory_update 的陈旧 expected_version 返回 REVISION_CONFLICT', async () => {
  const { client, close } = await connectedPair();
  try {
    const write = payloadOf(await client.callTool({
      name: 'memory_write',
      arguments: { title: 'MCP CAS', content: 'a', kind: 'fact' },
    }));
    const id = write.memory.id as string;
    payloadOf(await client.callTool({
      name: 'memory_update',
      arguments: { id, content: 'b', expected_version: 1 },
    }));
    const conflict = payloadOf(await client.callTool({
      name: 'memory_update',
      arguments: { id, content: 'c', expected_version: 1 },
    }));
    assert.equal(conflict.error?.code, 'REVISION_CONFLICT');
    assert.equal(conflict.error?.detail?.current_version, 2);

    const live = payloadOf(await client.callTool({ name: 'memory_read', arguments: { id } }));
    assert.equal(live.memory.content, 'b');
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// 5. HTTP surface
// ---------------------------------------------------------------------------

test('HTTP：PATCH 带 expected_version/If-Match 冲突返回 409，历史按版本可读', async () => {
  const f = seeded();
  const server = await startHub({ db: f.db, port: 0 });
  try {
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const json = async (path: string, init?: RequestInit) => {
      const res = await fetch(base + path, init);
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
    };
    const created = await json('/api/memories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: f.project.id,
        title: 'REST 版本',
        content: 'v1',
        kind: 'fact',
        evidence: [{ kind: 'url', locator: 'https://example.com/doc' }],
      }),
    });
    assert.equal(created.status, 201);
    const id = created.body.memory.id as string;
    assert.equal(created.body.memory.version, 1);
    assert.equal(created.body.memory.evidence[0].locator, 'https://example.com/doc');

    const patch = (body: unknown, headers: Record<string, string> = {}) =>
      json(`/api/memories/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });

    const ok = await patch({ content: 'v2', expected_version: 1 });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.memory.version, 2);

    const conflict = await patch({ content: '迟到的 ' , expected_version: 1 });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, 'REVISION_CONFLICT');
    assert.equal(conflict.body.detail.current_version, 2);

    const viaHeader = await patch({ content: 'v3' }, { 'If-Match': '"2"' });
    assert.equal(viaHeader.status, 200);
    assert.equal(viaHeader.body.memory.version, 3);

    const history = await json(`/api/memories/${id}/revisions`);
    assert.equal(history.status, 200);
    assert.equal(history.body.current_version, 3);
    assert.deepEqual(history.body.revisions.map((r: { version: number }) => r.version), [2, 1]);

    const at1 = await json(`/api/memories/${id}?at_version=1`);
    assert.equal(at1.status, 200);
    assert.equal(at1.body.memory.content, 'v1');
    assert.equal(at1.body.live_version, 3);

    const bad = await json(`/api/memories/${id}?at_version=77`);
    assert.equal(bad.status, 404);
    assert.equal(bad.body.code, 'REVISION_NOT_FOUND');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.cleanup();
  }
});
