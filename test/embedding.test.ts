import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ensureProject } from '../src/projects.js';
import * as store from '../src/store.js';
import * as vec from '../src/vec.js';
import type { Embedder } from '../src/embedding.js';
import { fixture } from './helpers.js';

/** Deterministic fake embedder: 3-dim vectors keyed by topic keywords. */
function fakeEmbedder(modelName: string): Embedder {
  return {
    modelName,
    dimension: 0,
    async embed(texts: string[]) {
      this.dimension = 3;
      return texts.map((text) => {
        if (/数据库|选型|PostgreSQL|SQLite/i.test(text)) return [1, 0, 0];
        if (/部署|deploy|发布/i.test(text)) return [0, 1, 0];
        return [0.3, 0.3, 0.4];
      });
    },
  };
}

function seeded() {
  const f = fixture();
  const project = ensureProject(f.db, f.projDir, { withMarker: true });
  return { ...f, project };
}

test('BLOB 向量往返与余弦相似度', () => {
  const a = new Float32Array([1, 0, 0]);
  const b = new Float32Array([1, 0, 0]);
  const c = new Float32Array([0, 1, 0]);
  assert.equal(vec.cosine(a, b), 1);
  assert.equal(vec.cosine(a, c), 0);
});

test('写入时建向量索引，混合检索命中词法无法命中的语义关联', async () => {
  const f = seeded();
  try {
    const embedder = fakeEmbedder('fake-a');
    // 内容不含"数据库"三个字，词法检索查不到
    const m = store.writeMemory(f.db, {
      projectId: f.project.id, title: '存储选型', content: '最终采用 PostgreSQL。', kind: 'decision',
    });
    await vec.embedMemoryBestEffort(f.db, embedder, m);

    // 词法路径确认查不到
    const lexical = store.searchMemories(f.db, { projectId: f.project.id, query: '数据库' });
    assert.equal(lexical.hits.length, 0);

    // 混合检索通过语义命中
    const hybrid = await vec.hybridSearch(f.db, embedder, {
      projectId: f.project.id, query: '数据库', limit: 10,
    });
    assert.equal(hybrid.mode, 'hybrid');
    assert.ok(hybrid.hits.length >= 1);
    assert.equal(hybrid.hits[0].id, m.id);
    assert.ok(hybrid.hits[0].semanticScore !== null && (hybrid.hits[0].semanticScore as number) > 0.9);
  } finally {
    f.cleanup();
  }
});

test('模型身份三态：unknown 记录 → match 放行 → mismatch 降级并警告', async () => {
  const f = seeded();
  try {
    const a = fakeEmbedder('fake-a');
    const b = fakeEmbedder('fake-b');
    assert.equal(vec.checkIdentity(f.db, a), 'unknown');

    const m = store.writeMemory(f.db, {
      projectId: f.project.id, title: '决策', content: '内容', kind: 'decision',
    });
    await vec.embedMemoryBestEffort(f.db, a, m);
    assert.equal(vec.checkIdentity(f.db, a), 'match');

    // 换模型：写入跳过索引，检索降级为词法并带警告
    await vec.embedMemoryBestEffort(f.db, b, m);
    const rows = f.db.prepare('SELECT model_name FROM memory_embeddings').all() as Array<{ model_name: string }>;
    assert.ok(rows.every((r) => r.model_name === 'fake-a'), 'mismatch must not touch the index');

    const result = await vec.hybridSearch(f.db, b, { projectId: f.project.id, query: '决策' });
    assert.ok((result.warnings ?? []).some((w) => w.includes('repair-embeddings')));
    assert.notEqual(result.mode, 'hybrid');

    // 修复后恢复混合检索
    const repaired = await vec.reindexEmbeddings(f.db, b);
    assert.ok(repaired.embedded >= 1);
    assert.equal(vec.checkIdentity(f.db, b), 'match');
    const hybrid = await vec.hybridSearch(f.db, b, { projectId: f.project.id, query: '决策' });
    assert.equal(hybrid.mode, 'hybrid');
  } finally {
    f.cleanup();
  }
});

test('无嵌入 provider 时全部功能保持词法模式', async () => {
  const f = seeded();
  try {
    const m = store.writeMemory(f.db, {
      projectId: f.project.id, title: '普通决策', content: '普通内容', kind: 'decision',
    });
    await vec.embedMemoryBestEffort(f.db, null, m);
    const result = await vec.hybridSearch(f.db, null, { projectId: f.project.id, query: '决策' });
    assert.ok(result.hits.length >= 1);
    assert.notEqual(result.mode, 'hybrid');
  } finally {
    f.cleanup();
  }
});

test('topic_key 修订与内容更新后重新嵌入（向量不陈旧）', async () => {
  const f = seeded();
  try {
    const embedder = fakeEmbedder('fake-a');
    // v1: 部署主题 → 向量 [0,1,0]
    const v1 = store.writeMemory(f.db, {
      projectId: f.project.id, title: '部署方式', content: '使用 Docker 部署。', kind: 'procedure', topicKey: 'deploy/current',
    });
    await vec.embedMemoryBestEffort(f.db, embedder, v1);
    const vec1 = f.db.prepare('SELECT vector FROM memory_embeddings WHERE memory_id = ?').get(v1.id) as { vector: Uint8Array };
    assert.equal(new Float32Array(vec1.vector.buffer.slice(0, 12))[1], 1, 'v1 vector is deploy-themed');

    // 修订为数据库主题 → 向量必须变为 [1,0,0]
    const v2 = store.writeMemory(f.db, {
      projectId: f.project.id, title: '部署方式', content: '改为 PostgreSQL 数据库方案。', kind: 'procedure', topicKey: 'deploy/current',
    });
    assert.equal(v2.id, v1.id, 'topic upsert revises in place');
    assert.equal(v2.revision_count, 2);
    await vec.embedMemoryBestEffort(f.db, embedder, v2);
    const vec2 = f.db.prepare('SELECT vector FROM memory_embeddings WHERE memory_id = ?').get(v2.id) as { vector: Uint8Array };
    const f2 = new Float32Array(vec2.vector.buffer.slice(0, 12));
    assert.equal(f2[0], 1, 'revised vector is database-themed');
    assert.equal(f2[1], 0, 'old deploy dimension cleared');

    // 修订后语义检索命中新主题
    const result = await vec.hybridSearch(f.db, embedder, { projectId: f.project.id, query: '数据库' });
    assert.ok(result.hits.some((h) => h.id === v2.id && (h.semanticScore ?? 0) > 0.9));
  } finally {
    f.cleanup();
  }
});
