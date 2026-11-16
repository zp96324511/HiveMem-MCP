import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { importClaudeSessions } from '../src/import.js';
import { ensureProject } from '../src/projects.js';
import * as store from '../src/store.js';
import { fixture } from './helpers.js';

function writeSession(dir: string, id: string, lines: unknown[]): string {
  const file = path.join(dir, `${id}.jsonl`);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return file;
}

test('导入 Claude Code 会话：摘要、时间戳保留、幂等', () => {
  const f = fixture();
  try {
    const project = ensureProject(f.db, f.projDir, { withMarker: true });
    writeSession(f.dir, '11111111-2222-3333-4444-555555555555', [
      { type: 'user', isMeta: true, message: { content: 'meta line skipped' } },
      { type: 'user', timestamp: '2026-10-01T10:00:00.000Z', message: { content: '帮我把登录改成 JWT' } },
      { type: 'user', timestamp: '2026-10-01T10:00:05.000Z', message: { content: '<system-reminder>command tag skipped</system-reminder>' } },
      { type: 'assistant', timestamp: '2026-10-01T10:01:00.000Z', message: { content: [{ type: 'text', text: '已完成，改了 auth.ts 的签发逻辑。' }] } },
    ]);
    writeSession(f.dir, '99999999-8888-7777-6666-555555555555', [
      { type: 'user', timestamp: '2026-10-05T09:00:00.000Z', message: { content: '修一下构建报错' } },
      { type: 'assistant', timestamp: '2026-10-05T09:02:00.000Z', message: { content: [{ type: 'text', text: '是 tsconfig 的 target 问题，已修复。' }] } },
    ]);

    const result = importClaudeSessions(f.db, { src: f.dir, projectRef: f.projDir, ttlDays: 90 });
    assert.equal(result.files, 2);
    assert.equal(result.imported, 2);
    assert.equal(result.skipped, 0);

    const searchResult = store.searchMemories(f.db, { projectId: project.id, query: '登录', status: 'active' });
    assert.ok(searchResult.hits.length >= 1);
    const imported = searchResult.hits[0];
    assert.equal(imported.source_agent, 'claude-code');
    assert.equal(imported.kind, 'episodic');
    assert.ok(imported.tags.includes('imported'));
    assert.equal(imported.created_at, '2026-10-01T10:00:00.000Z', 'original timestamps preserved');
    assert.ok(imported.expires_at, 'import applies TTL');
    assert.ok(imported.content.includes('JWT'));
    assert.ok(imported.content.includes('auth.ts'));
    assert.ok(!imported.content.includes('system-reminder'), 'command tags are filtered');
    assert.ok(!imported.content.includes('meta line'), 'meta lines are filtered');

    // 幂等：重导入全部跳过
    const again = importClaudeSessions(f.db, { src: f.dir, projectRef: f.projDir, ttlDays: 90 });
    assert.equal(again.imported, 0);
    assert.equal(again.skipped, 2);
  } finally {
    f.cleanup();
  }
});

test('空会话与单文件导入', () => {
  const f = fixture();
  try {
    const project = ensureProject(f.db, f.projDir, { withMarker: true });
    const empty = writeSession(f.dir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', [
      { type: 'user', isMeta: true, message: { content: 'only meta' } },
    ]);
    const result = importClaudeSessions(f.db, { src: empty, projectRef: f.projDir });
    assert.equal(result.imported, 0);
    assert.equal(result.skipped, 1);

    const single = writeSession(f.dir, 'ffffffff-0000-1111-2222-333333333333', [
      { type: 'user', timestamp: '2026-10-06T12:00:00.000Z', message: { content: '单文件导入测试' } },
    ]);
    const result2 = importClaudeSessions(f.db, { src: single, projectRef: f.projDir, ttlDays: 0 });
    assert.equal(result2.imported, 1);
    const search2 = store.searchMemories(f.db, { projectId: project.id, query: '单文件' });
    assert.equal(search2.hits.length, 1);
    assert.equal(search2.hits[0].expires_at, null, 'ttlDays 0 disables expiry');
  } finally {
    f.cleanup();
  }
});
