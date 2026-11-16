import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ensureProject, ensureUserProject } from '../src/projects.js';
import * as store from '../src/store.js';
import { fixture } from './helpers.js';

function seeded() {
  const f = fixture();
  const project = ensureProject(f.db, f.projDir, { withMarker: true });
  return { ...f, project };
}

test('写入与读取往返，tags 正确序列化', () => {
  const f = seeded();
  try {
    const created = store.writeMemory(f.db, {
      projectId: f.project.id,
      title: '数据库选型',
      content: '选择 SQLite：零运维、单文件、嵌入式。',
      kind: 'decision',
      tags: ['storage', '架构'],
      importance: 0.9,
      pinned: true,
      sourceAgent: 'claude-code',
    });
    assert.ok(created.id.startsWith('mem_'));
    assert.deepEqual(created.tags, ['storage', '架构']);
    assert.equal(created.pinned, true);
    const read = store.getMemory(f.db, created.id);
    assert.equal(read?.title, '数据库选型');
  } finally {
    f.cleanup();
  }
});

test('中文检索：长查询走 FTS，短查询走 LIKE，均可命中', () => {
  const f = seeded();
  try {
    store.writeMemory(f.db, {
      projectId: f.project.id,
      title: '数据库选型决策',
      content: '选择 SQLite 而不是 Postgres，因为零运维且便于分发。',
      kind: 'decision',
    });
    store.writeMemory(f.db, {
      projectId: f.project.id,
      title: '部署流程',
      content: '用 pnpm build 后复制 dist 到服务器。',
      kind: 'procedure',
    });

    const fts = store.searchMemories(f.db, { projectId: f.project.id, query: '选择 SQLite' });
    assert.equal(fts.mode, 'fts');
    assert.ok(fts.hits.length >= 1);
    assert.ok(fts.hits[0].title.includes('数据库'));

    const short = store.searchMemories(f.db, { projectId: f.project.id, query: '选型' });
    assert.equal(short.mode, 'substring');
    assert.ok(short.hits.length >= 1);

    const miss = store.searchMemories(f.db, { projectId: f.project.id, query: '完全不相关的内容' });
    assert.equal(miss.hits.length, 0);
  } finally {
    f.cleanup();
  }
});

test('混合排序：置顶与重要性提升排名', () => {
  const f = seeded();
  try {
    const low = store.writeMemory(f.db, {
      projectId: f.project.id, title: '普通笔记', content: '关于部署的普通记录', kind: 'fact', importance: 0.2,
    });
    store.writeMemory(f.db, {
      projectId: f.project.id, title: '部署约定', content: '关于部署的重要约定', kind: 'decision', importance: 0.95, pinned: true,
    });
    const result = store.searchMemories(f.db, { projectId: f.project.id, query: '部署' });
    assert.ok(result.hits.length >= 2);
    assert.notEqual(result.hits[0].id, low.id, 'pinned high-importance memory should rank first');
  } finally {
    f.cleanup();
  }
});

test('更新记录审计快照，归档后默认检索不可见', () => {
  const f = seeded();
  try {
    const created = store.writeMemory(f.db, {
      projectId: f.project.id, title: '旧标题', content: '旧内容', kind: 'fact',
    });
    const updated = store.updateMemory(f.db, f.project.id, created.id, { title: '新标题' }, 'cursor');
    assert.equal(updated.title, '新标题');
    assert.equal(updated.status, 'active');

    store.archiveMemory(f.db, f.project.id, created.id, 'cursor');

    const activeOnly = store.searchMemories(f.db, { projectId: f.project.id, query: '标题', status: 'active' });
    assert.equal(activeOnly.hits.length, 0, 'archived memory must be hidden from default search');
    const includingArchived = store.searchMemories(f.db, { projectId: f.project.id, query: '标题', status: 'archived' });
    assert.ok(includingArchived.hits.length >= 1);

    const audit = store.recentAudit(f.db, { projectId: f.project.id });
    const updates = audit.filter((e) => e.action === 'update');
    assert.equal(updates.length, 2, 'title change and archive are both audited as updates');
    const titleChange = updates.find(
      (e) => (e.detail as { previous?: { title?: string } }).previous?.title === '旧标题',
    );
    assert.ok(titleChange, 'audit keeps the previous snapshot of the title change');
    assert.equal(titleChange.actor, 'cursor');
  } finally {
    f.cleanup();
  }
});

test('项目隔离：检索只返回当前项目的记忆', () => {
  const f = seeded();
  try {
    const other = ensureProject(f.db, path.join(f.dir, 'otherproj'), { withMarker: true });
    store.writeMemory(f.db, { projectId: f.project.id, title: '本项目记忆', content: '内容', kind: 'fact' });
    store.writeMemory(f.db, { projectId: other.id, title: '他项目记忆', content: '内容', kind: 'fact' });
    const result = store.searchMemories(f.db, { projectId: f.project.id, query: '记忆' });
    assert.ok(result.hits.every((m) => m.project_id === f.project.id));
    assert.equal(result.hits.length, 1);
  } finally {
    f.cleanup();
  }
});

test('跨项目移动：换项目后检索隔离正确且留审计', () => {
  const f = seeded();
  try {
    const other = ensureProject(f.db, path.join(f.dir, 'otherproj'), { withMarker: true });
    const created = store.writeMemory(f.db, {
      projectId: f.project.id, title: '移动测试', content: '内容', kind: 'fact',
    });
    const moved = store.moveMemory(f.db, created.id, other.id, 'web');
    assert.equal(moved.project_id, other.id);
    assert.equal(store.searchMemories(f.db, { projectId: f.project.id, query: '移动测试' }).hits.length, 0);
    assert.equal(store.searchMemories(f.db, { projectId: other.id, query: '移动测试' }).hits.length, 1);
    const audit = store.recentAudit(f.db, { projectId: other.id });
    assert.ok(audit.some((e) => e.action === 'move'));
    const noop = store.moveMemory(f.db, created.id, other.id, 'web');
    assert.equal(noop.project_id, other.id);
  } finally {
    f.cleanup();
  }
});

test('bootstrap 简报包含置顶与决策，且受预算约束', () => {
  const f = seeded();
  try {
    store.writeMemory(f.db, {
      projectId: f.project.id, title: '置顶约定', content: '所有提交走 squash merge。', kind: 'preference', pinned: true, importance: 0.9,
    });
    store.writeMemory(f.db, {
      projectId: f.project.id, title: '决策：用 SQLite', content: '理由：零运维。', kind: 'decision', importance: 0.8,
    });
    store.writeMemory(f.db, {
      projectId: f.project.id, title: '无关过程', content: '今天开了个会。', kind: 'episodic', importance: 0.1,
    });
    const brief = store.bootstrapBrief(f.db, f.project.id, 2600);
    assert.ok(brief.rendered.includes('置顶约定'));
    assert.ok(brief.rendered.includes('决策：用 SQLite'));
    assert.ok(brief.rendered.includes('无关过程'), 'recent episodic belongs in the brief for session continuity');
    assert.ok(brief.sources.length >= 3);

    const tiny = store.bootstrapBrief(f.db, f.project.id, 30);
    assert.ok(tiny.rendered.length <= 30 + 40, 'budget must bound the rendered brief');
    assert.equal(typeof tiny.truncated, 'boolean');
  } finally {
    f.cleanup();
  }
});

test('简报跟随更新：默认重要性 fact、procedure、最近更新兜底（gwm_app 场景）', () => {
  const f = seeded();
  try {
    // 全部默认 importance 0.5（agent 不设重要性的真实习惯），旧逻辑下简报为空
    store.writeMemory(f.db, {
      projectId: f.project.id, title: 'GWM 登录闭环', content: 'G_A 加密 + guser 签名 + 重放。', kind: 'fact',
    });
    store.writeMemory(f.db, {
      projectId: f.project.id, title: '流量约束', content: 'app 流量禁止经过 PC。', kind: 'preference',
    });
    const brief = store.bootstrapBrief(f.db, f.project.id);
    assert.ok(brief.rendered.includes('GWM 登录闭环'), 'default-importance fact must appear');
    assert.ok(brief.rendered.includes('流量约束'), 'default-importance preference must appear');
    assert.ok(!brief.rendered.startsWith('## 最近更新') || brief.sources.length >= 2);

    // procedure 有分区可见
    store.writeMemory(f.db, {
      projectId: f.project.id, title: '逆向基础环境', content: '工具+脚本+方法论。', kind: 'procedure', importance: 0.9,
    });
    const brief2 = store.bootstrapBrief(f.db, f.project.id);
    assert.ok(brief2.rendered.includes('逆向基础环境'), 'procedure must appear in the brief');

    // 最近更新兜底：新写入的 snippet（不属于任何策展分区）以标题索引行出现
    const fresh = store.writeMemory(f.db, {
      projectId: f.project.id, title: '签名公式位置', content: '关键逻辑在 auth.ts:120。', kind: 'snippet',
    });
    const brief3 = store.bootstrapBrief(f.db, f.project.id);
    assert.ok(brief3.rendered.includes('## 最近更新'), 'catch-all section present');
    assert.ok(brief3.rendered.includes('签名公式位置'), 'snippet appears via recently-updated index');
    assert.ok(brief3.rendered.includes(fresh.id), 'index line carries the memory id');
    assert.ok(brief3.sources.includes(fresh.id), 'index ids land in sources');
  } finally {
    f.cleanup();
  }
});

test('删除记忆后 FTS 索引同步清理', () => {
  const f = seeded();
  try {
    const created = store.writeMemory(f.db, {
      projectId: f.project.id, title: '待删除记忆', content: '独特关键词xyzzy', kind: 'fact',
    });
    assert.ok(store.searchMemories(f.db, { projectId: f.project.id, query: 'xyzzy' }).hits.length === 1);
    store.deleteMemory(f.db, f.project.id, created.id, 'test');
    assert.equal(store.searchMemories(f.db, { projectId: f.project.id, query: 'xyzzy' }).hits.length, 0);
    assert.equal(store.getMemory(f.db, created.id), null);
  } finally {
    f.cleanup();
  }
});

test('memory_index：total 始终是匹配总数，分页边界正确', () => {
  const f = seeded();
  try {
    for (let i = 1; i <= 7; i++) {
      store.writeMemory(f.db, { projectId: f.project.id, title: `事实-${i}`, content: `内容 ${i}`, kind: 'fact' });
    }
    for (let i = 1; i <= 3; i++) {
      store.writeMemory(f.db, { projectId: f.project.id, title: `决策-${i}`, content: `决策 ${i}`, kind: 'decision' });
    }
    const first = store.listIndex(f.db, f.project.id, { limit: 4 });
    assert.equal(first.total, 10, 'total counts every match, not the page');
    assert.equal(first.entries.length, 4);
    assert.equal(first.next_offset, 4);
    assert.equal(first.counts.total, 10);
    assert.equal(first.counts.by_kind.fact, 7);
    assert.equal(first.counts.by_scope.project, 10);

    const second = store.listIndex(f.db, f.project.id, { limit: 4, offset: 4 });
    assert.equal(second.total, 10);
    assert.equal(second.next_offset, 8);

    const last = store.listIndex(f.db, f.project.id, { limit: 4, offset: 8 });
    assert.equal(last.entries.length, 2);
    assert.equal(last.next_offset, null, 'last page has no next offset');

    const beyond = store.listIndex(f.db, f.project.id, { limit: 4, offset: 99 });
    assert.equal(beyond.total, 10, 'out-of-range page still reports the real total');
    assert.equal(beyond.entries.length, 0);
    assert.equal(beyond.next_offset, null);

    const decisions = store.listIndex(f.db, f.project.id, { kind: 'decision' });
    assert.equal(decisions.total, 3);
    assert.ok(decisions.entries.every((e) => e.kind === 'decision'));

    // 逐页遍历不重不漏
    const seen = new Set<string>();
    let offset = 0;
    for (;;) {
      const page = store.listIndex(f.db, f.project.id, { limit: 3, offset });
      for (const entry of page.entries) seen.add(entry.id);
      if (page.next_offset === null) break;
      offset = page.next_offset;
    }
    assert.equal(seen.size, 10);
  } finally {
    f.cleanup();
  }
});

test('memory_index：scope 按层隔离，counts 覆盖全项目', () => {
  const f = seeded();
  try {
    store.writeMemory(f.db, { projectId: f.project.id, title: '项目级记忆', content: 'x', kind: 'fact' });
    store.writeMemory(f.db, { projectId: f.project.id, title: '设备级记忆', content: 'x', kind: 'fact', device: 'pc-1' });
    store.writeMemory(f.db, {
      projectId: f.project.id, title: '工具级记忆', content: 'x', kind: 'fact', device: 'pc-1', agent: 'dsh',
    });
    assert.equal(store.listIndex(f.db, f.project.id, { scope: 'project' }).total, 1);
    assert.equal(store.listIndex(f.db, f.project.id, { scope: 'device' }).total, 1);
    const agent = store.listIndex(f.db, f.project.id, { scope: 'agent' });
    assert.equal(agent.total, 1);
    assert.equal(agent.entries[0].scope, 'agent');

    const all = store.listIndex(f.db, f.project.id);
    assert.equal(all.total, 3);
    assert.deepEqual(all.counts.by_scope, { project: 1, device: 1, agent: 1 });
  } finally {
    f.cleanup();
  }
});

test('简报截断时写明总数并指向全量索引（D）', () => {
  const f = seeded();
  try {
    for (let i = 1; i <= 30; i++) {
      store.writeMemory(f.db, {
        projectId: f.project.id,
        title: `长记忆-${i}：模块行为与约束`,
        content: `第 ${i} 条：${'这条记忆记录模块行为、配置项与已知坑点。'.repeat(8)}`,
        kind: i % 2 === 0 ? 'decision' : 'fact',
      });
    }
    const brief = store.bootstrapBrief(f.db, f.project.id, 1200);
    assert.equal(brief.truncated, true);
    assert.equal(brief.total, 30, 'brief reports how many active memories the project holds');
    assert.ok(brief.shown > 0 && brief.shown < 30, `shown must be a real subset (got ${brief.shown})`);
    assert.ok(brief.rendered.includes('已截断'), 'footer states the truncation');
    assert.ok(brief.rendered.includes(`${brief.total} 条 active`), 'footer carries the project total');
    assert.ok(
      brief.rendered.includes(`memory://projects/${f.project.id}/index`),
      'footer points at the index resource',
    );
    assert.ok(brief.rendered.includes('memory_index'), 'footer names the enumeration tool');
    assert.ok(brief.rendered.length <= 1200, 'footer must respect the budget invariant');
    assert.equal(brief.truncated, brief.shown < brief.total, 'truncated must mean something is actually missing');
    // The gap is split by cause, and the split adds up to the gap.
    assert.equal(brief.omitted.budget + brief.omitted.priority, brief.total - brief.shown);
    assert.ok(brief.omitted.budget > 0, 'a 1200-char budget cannot fit 30 long memories');
    assert.ok(
      brief.rendered.includes(`预算 ${brief.omitted.budget} 条`),
      'footer names the budget share of the gap',
    );
    // Each line carries its CAS token, so a reader can write back without a
    // second read (and without clobbering a concurrent edit).
    assert.match(brief.rendered, /- \[mem_[a-z0-9]+\] v1 /, '每行带版本号');
  } finally {
    f.cleanup();
  }
});

test('简报逐条标注：内容被裁的条目自己说「已截断」，整条没塞下的不进正文', () => {
  const f = seeded();
  try {
    store.writeMemory(f.db, {
      projectId: f.project.id,
      title: '长正文决策',
      content: 'A'.repeat(600),
      kind: 'decision',
    });
    const brief = store.bootstrapBrief(f.db, f.project.id, 1400);
    const line = brief.rendered.split('\n').find((l) => l.includes('长正文决策'));
    assert.ok(line, 'the memory is listed');
    assert.match(line, /…（已截断）/, 'the clipped entry marks itself');
    assert.ok(!brief.rendered.includes('A'.repeat(200)), 'the body is bounded, not dumped');
    // A version bump shows up in the brief immediately (v2 after one update).
    const before = store.writeMemory(f.db, { projectId: f.project.id, title: '会改的记忆', content: '第一版', kind: 'fact' });
    const updated = store.updateMemory(f.db, f.project.id, before.id, { content: '第二版' });
    const after = store.bootstrapBrief(f.db, f.project.id, 4000);
    assert.ok(after.rendered.includes(`[${updated.id}] v2 会改的记忆`), 'brief carries the current version');
    assert.equal(updated.version, 2);
  } finally {
    f.cleanup();
  }
});

test('简报省略原因：只被分区名额挡掉的记忆计为 priority，不计入 budget', () => {
  const f = seeded();
  try {
    // 40 decisions: the 关键决策 section caps at 15 rows, so at a generous
    // budget the missing ones are a naming/selection limit, not a budget one.
    for (let i = 1; i <= 40; i++) {
      store.writeMemory(f.db, {
        projectId: f.project.id,
        title: `决策 ${i}`,
        content: `第 ${i} 条决策正文`,
        kind: 'decision',
      });
    }
    const brief = store.bootstrapBrief(f.db, f.project.id, 8000);
    assert.ok(brief.omitted.priority > 0, 'section limits, not the budget, drop the tail');
    assert.equal(brief.omitted.budget, 0, 'nothing was dropped for space at 8000 chars');
    assert.match(brief.rendered, /名额 \d+ 条/, 'footer names the priority share');
  } finally {
    f.cleanup();
  }
});

test('简报完整时不加截断页脚', () => {
  const f = seeded();
  try {
    store.writeMemory(f.db, { projectId: f.project.id, title: '唯一记忆', content: '内容', kind: 'fact' });
    const brief = store.bootstrapBrief(f.db, f.project.id);
    assert.equal(brief.truncated, false);
    assert.equal(brief.total, 1);
    assert.equal(brief.shown, 1);
    assert.deepEqual(brief.userLevel, { total: 0, shown: 0 });
    assert.ok(!brief.rendered.includes('已截断'), 'no footer when the brief covers the whole project');
  } finally {
    f.cleanup();
  }
});

test('用户级记忆被裁时单独说明：项目正文完整也要说清楚少了什么', () => {
  const f = seeded();
  try {
    const userProjectId = ensureUserProject(f.db).id;
    // 10 cross-project rows: more than the dedicated section can list, while the
    // project body itself is complete. Without its own footer the brief would
    // look complete and silently hide user-level preferences.
    for (let i = 0; i < 10; i++) {
      store.writeMemory(f.db, {
        projectId: userProjectId,
        title: `跨项目偏好 ${i}`,
        content: `偏好正文 ${i}：`.repeat(12),
        kind: 'preference',
        importance: 0.9,
      });
    }
    store.writeMemory(f.db, { projectId: f.project.id, title: '项目内唯一事实', content: '内容', kind: 'fact' });

    const brief = store.bootstrapBrief(f.db, f.project.id, 2600);
    assert.equal(brief.total, 1, 'user-level rows never count toward the project total');
    assert.equal(brief.shown, 1);
    assert.equal(brief.omitted.budget + brief.omitted.priority, 0);
    assert.equal(brief.userLevel.total, 10);
    assert.ok(brief.userLevel.shown < 10);
    assert.equal(brief.truncated, true, 'a thinned user layer is truncation');
    assert.ok(
      brief.rendered.includes(`用户级记忆 10 条中列出 ${brief.userLevel.shown} 条`),
      'the footer names the user-layer gap instead of hiding it behind truncated=true',
    );
    assert.ok(!brief.rendered.includes('本项目 1 条'), 'nothing to report on the project body itself');
  } finally {
    f.cleanup();
  }
});
