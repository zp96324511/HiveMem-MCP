import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ensureProject } from '../src/projects.js';
import * as store from '../src/store.js';
import { setupDsh } from '../src/setup.js';
import { createMcpServer } from '../src/mcp.js';
import { importClaudeSessions } from '../src/import.js';
import { hybridSearch } from '../src/vec.js';
import type { Embedder } from '../src/embedding.js';
import { fixture } from './helpers.js';

function seeded() {
  const f = fixture();
  const project = ensureProject(f.db, f.projDir, { withMarker: true });
  return { ...f, project };
}

test('topic_key upsert：同 key 原地修订，跨项目独立', () => {
  const f = seeded();
  try {
    const other = ensureProject(f.db, path.join(f.dir, 'otherproj'), { withMarker: true });
    const v1 = store.writeMemory(f.db, {
      projectId: f.project.id, title: '部署方式 v1', content: '用 Docker Compose。', kind: 'procedure', topicKey: 'deploy/method',
    });
    const v2 = store.writeMemory(f.db, {
      projectId: f.project.id, title: '部署方式 v2', content: '改用 Kubernetes。', kind: 'procedure', topicKey: 'deploy/method',
    });
    assert.equal(v2.id, v1.id, 'same topic key revises in place');
    assert.equal(v2.revision_count, 2);
    assert.equal(v2.title, '部署方式 v2');
    const count = (f.db.prepare('SELECT COUNT(*) AS n FROM memories WHERE project_id = ?').get(f.project.id) as { n: number }).n;
    assert.equal(count, 1, 'no duplicate row');

    // 跨项目独立
    const otherMem = store.writeMemory(f.db, {
      projectId: other.id, title: '他项目部署', content: 'x', kind: 'procedure', topicKey: 'deploy/method',
    });
    assert.notEqual(otherMem.id, v1.id);

    const audit = store.recentAudit(f.db, { projectId: f.project.id });
    assert.ok(audit.some((e) => e.action === 'revise' && e.memory_id === v1.id));
  } finally {
    f.cleanup();
  }
});

test('review 周期：默认按 kind 设置，到期标记 needsReview，复审重置', () => {
  const f = seeded();
  try {
    const m = store.writeMemory(f.db, {
      projectId: f.project.id, title: '偏好', content: '中文回复', kind: 'preference',
    });
    assert.ok(m.review_after, 'preference gets a review date');
    assert.ok(Date.parse(m.review_after as string) > Date.now() + 89 * 86_400_000, '~90 days out');

    const noReview = store.writeMemory(f.db, {
      projectId: f.project.id, title: '过程', content: 'x', kind: 'episodic',
    });
    assert.equal(noReview.review_after, null, 'episodic has no review cycle');

    // 人为过期
    f.db.prepare('UPDATE memories SET review_after = ? WHERE id = ?').run(
      new Date(Date.now() - 86_400_000).toISOString(), m.id,
    );
    const hits = store.searchMemories(f.db, { projectId: f.project.id, query: '偏好' });
    assert.equal(hits.hits[0].needsReview, true, 'overdue memory is flagged');

    assert.equal(store.reviewList(f.db, f.project.id).length, 1);
    const reviewed = store.markReviewed(f.db, f.project.id, m.id, 'test');
    assert.ok(reviewed.review_after && Date.parse(reviewed.review_after) > Date.now(), 'review restarts');
    assert.equal(store.reviewList(f.db, f.project.id).length, 0);
    const after = store.searchMemories(f.db, { projectId: f.project.id, query: '偏好' });
    assert.equal(after.hits[0].needsReview, false);

    const audit = store.recentAudit(f.db, { projectId: f.project.id });
    assert.ok(audit.some((e) => e.action === 'review'));
  } finally {
    f.cleanup();
  }
});

test('MCP：memory_write 相似提示 + topic_key 修订 + memory_review + resource', async () => {
  const f = seeded();
  const server = createMcpServer({ db: f.db, cwd: f.projDir, httpMode: false, agent: 'test' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(clientTransport);
  try {
    const payload = (r: unknown) => JSON.parse((r as { content: Array<{ text: string }> }).content[0].text);

    // 第一次写入
    const w1 = payload(await client.callTool({
      name: 'memory_write',
      arguments: { title: '认证方案', content: '采用 JWT。', kind: 'decision' },
    }));
    assert.ok(w1.memory.id);

    // 相似标题再写 → similar_existing 提示
    const w2 = payload(await client.callTool({
      name: 'memory_write',
      arguments: { title: '认证方案的选择', content: '采用 session。', kind: 'decision' },
    }));
    assert.ok(Array.isArray(w2.similar_existing) && w2.similar_existing.length >= 1, 'near-duplicate surfaced');
    assert.ok(w2.hint);

    // topic_key 修订
    const w3 = payload(await client.callTool({
      name: 'memory_write',
      arguments: { title: '认证方案 v2', content: '改用 OAuth2。', kind: 'decision', topic_key: 'auth/model' },
    }));
    const w4 = payload(await client.callTool({
      name: 'memory_write',
      arguments: { title: '认证方案 v3', content: 'OAuth2 + PKCE。', kind: 'decision', topic_key: 'auth/model' },
    }));
    assert.equal(w4.memory.id, w3.memory.id);
    assert.equal(w4.memory.revision_count, 2);
    assert.ok(w4.note && String(w4.note).includes('auth/model'));

    // memory_review list（无到期）
    const rv = payload(await client.callTool({
      name: 'memory_review', arguments: { action: 'list' },
    }));
    assert.equal(rv.count, 0);

    // resource：读简报
    const resource = await client.readResource({ uri: `memory://projects/${f.project.id}/brief` });
    const text = resource.contents[0].text as string;
    assert.ok(text.includes('记忆简报'));
    assert.ok(text.includes('认证方案 v3'), 'brief reflects latest revision');
  } finally {
    await client.close();
    await server.close();
    f.cleanup();
  }
});

test('语义 fallback 模式：词法命中时不调嵌入', async () => {
  const f = seeded();
  try {
    let embedCalls = 0;
    const embedder: Embedder = {
      modelName: 'fake', dimension: 3,
      async embed(texts: string[]) { embedCalls++; return texts.map(() => [1, 0, 0]); },
    };
    const m = store.writeMemory(f.db, {
      projectId: f.project.id, title: '数据库选型', content: 'SQLite。', kind: 'decision',
    });
    // 先建向量索引（此时 embedCalls=1）
    await (await import('../src/vec.js')).embedMemoryBestEffort(f.db, embedder, m);
    embedCalls = 0;

    process.env.HIVEMEM_SEMANTIC_MODE = 'fallback';
    try {
      const hit = await hybridSearch(f.db, embedder, { projectId: f.project.id, query: '数据库' });
      assert.ok(hit.hits.length >= 1);
      assert.notEqual(hit.mode, 'hybrid', 'lexical hit skips embedding');
      assert.equal(embedCalls, 0, 'embedder not called');

      const miss = await hybridSearch(f.db, embedder, { projectId: f.project.id, query: '完全无关的查询词组' });
      assert.equal(embedCalls, 1, 'fallback embeds only when lexical misses');
      assert.equal(miss.mode, 'hybrid');
    } finally {
      delete process.env.HIVEMEM_SEMANTIC_MODE;
    }
  } finally {
    f.cleanup();
  }
});

test('setup 幂等：已配置则不重复写入', () => {
  const f = fixture();
  try {
    const home = path.join(f.dir, 'dshhome');
    const profileDir = path.join(home, 'profiles', 'web');
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '[]\n', 'utf8');
    process.env.DSH_HOME = home;
    try {
      const first = setupDsh();
      assert.equal(first.written, true);
      const content = readFileSync(path.join(home, 'cordis.patch.yml'), 'utf8');
      assert.ok(content.includes('mcp-hivemem'));

      const second = setupDsh();
      assert.equal(second.written, false, 'idempotent on re-run');
    } finally {
      delete process.env.DSH_HOME;
    }
  } finally {
    f.cleanup();
  }
});

test('setup v2：新写入带 device/token 头；已有条目原地补头且不碰邻居', () => {
  const f = fixture();
  try {
    const home = path.join(f.dir, 'dshhome2');
    const profileDir = path.join(home, 'profiles', 'web');
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '[]\n', 'utf8');
    process.env.DSH_HOME = home;
    try {
      // Fresh write carries the requested headers.
      const first = setupDsh({ device: 'win10-desk', token: 'tok123' });
      assert.equal(first.written, true);
      const content = readFileSync(path.join(home, 'cordis.patch.yml'), 'utf8');
      assert.ok(content.includes('X-HiveMem-Device: win10-desk'));
      assert.ok(content.includes('Authorization: Bearer tok123'));

      // Re-run with the same headers: nothing to add, no duplication.
      const again = setupDsh({ device: 'win10-desk', token: 'tok123' });
      assert.equal(again.written, false);
      assert.equal(again.upgraded, undefined);
      assert.equal(readFileSync(path.join(home, 'cordis.patch.yml'), 'utf8').match(/- id: mcp-hivemem/g)?.length, 1);

      // A hand-written v1 entry (no device header) is upgraded in place,
      // with matching indentation, and neighboring entries stay untouched.
      const homeFile = path.join(home, 'cordis.patch.yml');
      const handWritten = [
        '# HiveMem 记忆中枢（本地 hub）',
        '- insert:',
        '    - id: mcp-hivemem',
        "      name: '@deepseek-ai/dsh-mcp-client'",
        '      config:',
        '        serverName: hivemem',
        '        transport: streamable-http',
        '        url: http://127.0.0.1:7660/mcp',
        '        headers:',
        '          X-HiveMem-Agent: dsh',
        '',
        '- insert:',
        '    - id: mcp-onessh',
        "      name: '@deepseek-ai/dsh-mcp-client'",
        '      config:',
        '        serverName: onessh',
        '',
      ].join('\n') + '\n';
      writeFileSync(homeFile, handWritten, 'utf8');
      const upgraded = setupDsh({ device: 'win10-desk' });
      assert.equal(upgraded.written, false);
      assert.deepEqual(upgraded.upgraded, ['X-HiveMem-Device']);
      const after = readFileSync(homeFile, 'utf8');
      assert.ok(
        after.includes('X-HiveMem-Agent: dsh\n          X-HiveMem-Device: win10-desk'),
        'new header lands right after the agent header with matching indent',
      );
      assert.equal(after.match(/- id: mcp-hivemem/g)?.length, 1);
      assert.ok(after.includes('mcp-onessh'), 'neighboring entries untouched');
      assert.ok(!after.includes('Authorization'), 'token not added when not requested');
    } finally {
      delete process.env.DSH_HOME;
    }
  } finally {
    f.cleanup();
  }
});

test('import：不可读行被计数报告', () => {
  const f = fixture();
  try {
    const project = ensureProject(f.db, f.projDir, { withMarker: true });
    const file = path.join(f.dir, 'bad.jsonl');
    writeFileSync(file, [
      '{"type":"user","timestamp":"2026-10-20T09:00:00.000Z","message":{"content":"正常行"}}',
      'this is not json {{{',
      'another broken line',
    ].join('\n') + '\n', 'utf8');
    const result = importClaudeSessions(f.db, { src: file, projectRef: f.projDir, ttlDays: 0 });
    assert.equal(result.imported, 1);
    assert.equal(result.unreadable, 2, 'broken lines are reported, not silently dropped');
    assert.ok(store.searchMemories(f.db, { projectId: project.id, query: '正常行' }).hits.length === 1);
  } finally {
    f.cleanup();
  }
});
