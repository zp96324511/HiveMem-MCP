import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ensureProject } from '../src/projects.js';
import * as store from '../src/store.js';
import { fixture } from './helpers.js';

function seeded() {
  const f = fixture();
  const project = ensureProject(f.db, f.projDir, { withMarker: true });
  return { ...f, project };
}

test('TTL：到期后检索不可见，sweep 归档并留审计', () => {
  const f = seeded();
  try {
    const alive = store.writeMemory(f.db, {
      projectId: f.project.id, title: '存活记忆', content: '内容', kind: 'fact', ttlDays: 30,
    });
    const expired = store.writeMemory(f.db, {
      projectId: f.project.id, title: '过期记忆', content: '内容', kind: 'fact',
      expiresAt: new Date(Date.now() - 86_400_000).toISOString(),
    });
    assert.ok(alive.expires_at);
    assert.ok(expired.expires_at);

    const visible = store.searchMemories(f.db, { projectId: f.project.id, query: '记忆' });
    assert.equal(visible.hits.length, 1, 'expired memory is invisible to search');

    const brief = store.bootstrapBrief(f.db, f.project.id);
    assert.ok(!brief.rendered.includes('过期记忆'), 'expired memory stays out of the brief');

    const swept = store.sweepExpired(f.db);
    assert.equal(swept.archived, 1);
    const archived = store.getMemory(f.db, expired.id);
    assert.equal(archived?.status, 'archived');
    const audit = store.recentAudit(f.db, { projectId: f.project.id });
    assert.ok(audit.some((e) => e.action === 'expire'));

    // 归档后可通过显式 status 查看
    const archivedView = store.searchMemories(f.db, { projectId: f.project.id, query: '记忆', status: 'archived' });
    assert.ok(archivedView.hits.length >= 1);
  } finally {
    f.cleanup();
  }
});

test('supersedes：新记忆自动取代旧记忆，链完整可查', () => {
  const f = seeded();
  try {
    const old = store.writeMemory(f.db, {
      projectId: f.project.id, title: '旧决策：用 REST', content: '理由：简单。', kind: 'decision',
    });
    const fresh = store.writeMemory(f.db, {
      projectId: f.project.id, title: '新决策：改用 GraphQL', content: '理由：减少往返。', kind: 'decision',
      supersedes: old.id,
    });
    assert.equal(fresh.supersedes, old.id);

    const oldAfter = store.getMemory(f.db, old.id);
    assert.equal(oldAfter?.status, 'superseded');

    // 默认检索只见新决策
    const active = store.searchMemories(f.db, { projectId: f.project.id, query: '决策', status: 'active' });
    assert.ok(active.hits.length >= 1);
    assert.ok(active.hits.every((h) => h.id === fresh.id));

    // 链：从新查旧，从旧查新，顺序一致
    const chainFromNew = store.supersedeChain(f.db, f.project.id, fresh.id);
    const chainFromOld = store.supersedeChain(f.db, f.project.id, old.id);
    assert.deepEqual(chainFromNew.map((m) => m.id), chainFromOld.map((m) => m.id));
    assert.equal(chainFromNew.length, 2);
    assert.equal(chainFromNew[0].id, old.id, 'oldest first');
    assert.equal(chainFromNew[1].id, fresh.id);

    assert.ok(store.hasSuccessors(f.db, f.project.id, old.id));
    assert.ok(!store.hasSuccessors(f.db, f.project.id, fresh.id));

    const audit = store.recentAudit(f.db, { projectId: f.project.id });
    assert.ok(audit.some((e) => e.action === 'supersede' && e.memory_id === old.id));
  } finally {
    f.cleanup();
  }
});

test('supersedes 跨项目或不存在目标时报错', () => {
  const f = seeded();
  try {
    const other = ensureProject(f.db, path.join(f.dir, 'otherproj'), { withMarker: true });
    const foreign = store.writeMemory(f.db, {
      projectId: other.id, title: '他项目', content: '内容', kind: 'fact',
    });
    const throwsCode = (code: string) => (error: unknown) => {
      assert.ok(error instanceof Error);
      return (error as { code?: string }).code === code;
    };
    assert.throws(
      () => store.writeMemory(f.db, {
        projectId: f.project.id, title: 'x', content: 'y', kind: 'fact', supersedes: foreign.id,
      }),
      throwsCode('SUPERSEDE_TARGET_NOT_FOUND'),
    );
    assert.throws(
      () => store.writeMemory(f.db, {
        projectId: f.project.id, title: 'x', content: 'y', kind: 'fact', supersedes: 'mem_doesnotexist',
      }),
      throwsCode('SUPERSEDE_TARGET_NOT_FOUND'),
    );
  } finally {
    f.cleanup();
  }
});

test('last_accessed_at：读取时更新，不影响 updated_at', () => {
  const f = seeded();
  try {
    const m = store.writeMemory(f.db, {
      projectId: f.project.id, title: '访问测试', content: '内容', kind: 'fact',
    });
    assert.equal(m.last_accessed_at, null);
    const touched = store.getMemory(f.db, m.id, { touch: true });
    assert.ok(touched?.last_accessed_at, 'touch records last_accessed_at');
    assert.equal(touched?.updated_at, m.updated_at, 'touch must not change updated_at');
  } finally {
    f.cleanup();
  }
});
