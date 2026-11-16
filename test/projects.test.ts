import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { ensureProject, findProjectRoot, isPathRef, normalizeKey, normalizePathRef, resolveProject } from '../src/projects.js';
import { HiveMemError } from '../src/util.js';
import { fixture } from './helpers.js';

test('ensureProject 创建 marker、行与别名，且幂等', () => {
  const f = fixture();
  try {
    const p1 = ensureProject(f.db, f.projDir, { withMarker: true });
    const p2 = ensureProject(f.db, f.projDir, { withMarker: true });
    assert.equal(p1.id, p2.id);
    assert.ok(existsSync(path.join(f.projDir, '.hivemem', 'project.json')));
    assert.equal(p1.name, 'myproj');
    const aliases = f.db.prepare('SELECT COUNT(*) AS n FROM project_aliases').get() as { n: number };
    assert.equal(aliases.n, 1);
  } finally {
    f.cleanup();
  }
});

test('marker 随仓库走：clone 到不同路径解析到同一项目身份', async () => {
  const f = fixture();
  try {
    const original = ensureProject(f.db, f.projDir, { withMarker: true });
    // 模拟 git clone：只复制被提交的内容（含 marker），不带本地别名
    const cloneDir = path.join(f.dir, 'clone-at-another-path');
    mkdirSync(cloneDir);
    cpSync(path.join(f.projDir, '.hivemem'), path.join(cloneDir, '.hivemem'), { recursive: true });
    // 另一台"机器"：全新数据库
    const { openDb } = await import('../src/db.js');
    const otherDb = openDb(path.join(f.dir, 'other-machine.db'));
    try {
      const cloned = ensureProject(otherDb, cloneDir, { withMarker: true });
      assert.equal(cloned.id, original.id, 'identity travels with the committed marker');
      assert.notEqual(normalizeKey(cloneDir), normalizeKey(f.projDir));
    } finally {
      otherDb.close();
    }
  } finally {
    f.cleanup();
  }
});

test('findProjectRoot 从子目录向上查找 marker', () => {
  const f = fixture();
  try {
    ensureProject(f.db, f.projDir, { withMarker: true });
    const deep = path.join(f.projDir, 'a', 'b', 'c');
    mkdirSync(deep, { recursive: true });
    assert.equal(findProjectRoot(deep), path.resolve(f.projDir));
    assert.equal(findProjectRoot(f.dir), null);
  } finally {
    f.cleanup();
  }
});

test('resolveProject 支持 id、名称（不区分大小写）与路径', () => {
  const f = fixture();
  try {
    const created = ensureProject(f.db, f.projDir, { withMarker: true });
    assert.equal(resolveProject(f.db, created.id, { mode: 'read' }).id, created.id);
    assert.equal(resolveProject(f.db, 'MYPROJ', { mode: 'read' }).id, created.id);
    assert.equal(resolveProject(f.db, f.projDir, { mode: 'read' }).id, created.id);
    // 子目录路径也应归并到同一项目
    const sub = path.join(f.projDir, 'src');
    mkdirSync(sub);
    assert.equal(resolveProject(f.db, sub, { mode: 'read' }).id, created.id);
  } finally {
    f.cleanup();
  }
});

test('resolveProject 无引用时从 cwd 解析；read 模式不写 marker，write 模式回填', () => {
  const f = fixture();
  try {
    const readResolved = resolveProject(f.db, undefined, { cwd: f.projDir, mode: 'read' });
    assert.equal(readResolved.name, 'myproj');
    assert.ok(!existsSync(path.join(f.projDir, '.hivemem')), 'read mode must not write a marker');

    const writeResolved = resolveProject(f.db, undefined, { cwd: f.projDir, mode: 'write' });
    assert.equal(writeResolved.id, readResolved.id, 'read and write resolution must converge');
    assert.ok(existsSync(path.join(f.projDir, '.hivemem', 'project.json')), 'write mode backfills marker');
  } finally {
    f.cleanup();
  }
});

test('resolveProject 未知引用报错并列出已注册项目', () => {
  const f = fixture();
  try {
    ensureProject(f.db, f.projDir, { withMarker: true });
    assert.throws(
      () => resolveProject(f.db, '不存在的项目', { mode: 'read' }),
      (error: unknown) => {
        assert.ok(error instanceof HiveMemError);
        assert.equal(error.code, 'PROJECT_NOT_FOUND');
        const projects = (error.detail as { projects: unknown[] }).projects;
        assert.equal(projects.length, 1);
        return true;
      },
    );
  } finally {
    f.cleanup();
  }
});

test('normalizeKey 在 Windows 上大小写不敏感且分隔符归一', () => {
  const a = normalizeKey(process.cwd());
  const b = normalizeKey(process.cwd().toUpperCase());
  assert.equal(a, b);
  assert.ok(!a.includes('\\'));
});

test('同名目录注册自动加后缀，项目名引用保持无歧义', () => {
  const f = fixture();
  try {
    const first = ensureProject(f.db, f.projDir, { withMarker: true });
    assert.equal(first.name, 'myproj');
    // 另一个同名目录（不同物理路径）注册 → 自动 -2
    const secondDir = path.join(f.dir, 'elsewhere', 'myproj');
    mkdirSync(path.dirname(secondDir), { recursive: true });
    mkdirSync(secondDir);
    const second = ensureProject(f.db, secondDir, { withMarker: true });
    assert.equal(second.name, 'myproj-2', 'duplicate basename gets a suffix');
    assert.notEqual(second.id, first.id);

    // 名称引用各自命中，不串
    assert.equal(resolveProject(f.db, 'myproj', { mode: 'read' }).id, first.id);
    assert.equal(resolveProject(f.db, 'MYPROJ-2', { mode: 'read' }).id, second.id);
  } finally {
    f.cleanup();
  }
});

test('中心化 hub：客户端路径在服务端文件系统不可见时按注册表解析', () => {
  const f = fixture();
  try {
    // 模拟迁移到远程 Linux hub 的存量注册：行 + 别名在库，路径在本机文件系统不存在
    const ts = '2026-01-01T00:00:00Z';
    f.db
      .prepare(
        "INSERT INTO projects (id, name, root_path, created_at, updated_at) VALUES ('prj_win', 'winproj', ?, ?, ?)",
      )
      .run('q:/data/projects/winproj', ts, ts);
    f.db
      .prepare('INSERT INTO project_aliases (alias_path, project_id) VALUES (?, ?)')
      .run('q:/data/projects/winproj', 'prj_win');
    f.db
      .prepare(
        "INSERT INTO projects (id, name, root_path, created_at, updated_at) VALUES ('prj_nix', 'nixproj', ?, ?, ?)",
      )
      .run('/home/zp/nixproj', ts, ts);

    // Windows 风格引用：在 POSIX 服务端 path.isAbsolute 为 false，必须靠 isPathRef 识别
    assert.equal(isPathRef('Q:\\data\\projects\\winproj'), true);
    assert.equal(normalizePathRef('Q:\\Data\\Projects\\WinProj'), 'q:/data/projects/winproj');
    assert.equal(resolveProject(f.db, 'Q:\\data\\projects\\winproj', { mode: 'read' }).id, 'prj_win');
    // 正斜杠 + 大小写差异同样归一命中
    assert.equal(resolveProject(f.db, 'Q:/Data/Projects/WinProj', { mode: 'read' }).id, 'prj_win');
    // POSIX 客户端路径（无别名，走 root_path 兜底）
    assert.equal(resolveProject(f.db, '/home/zp/nixproj', { mode: 'read' }).id, 'prj_nix');
    // 未注册路径不静默注册，仍报 PROJECT_NOT_FOUND
    assert.throws(
      () => resolveProject(f.db, 'Q:\\data\\projects\\unknown', { mode: 'write' }),
      (error: unknown) => error instanceof HiveMemError && error.code === 'PROJECT_NOT_FOUND',
    );
  } finally {
    f.cleanup();
  }
});

test('遗留重名数据：名称引用报歧义错误而非静默选第一个', () => {
  const f = fixture();
  try {
    const a = ensureProject(f.db, f.projDir, { withMarker: true });
    // 直接插入一个同名遗留行（模拟旧数据）
    f.db.prepare(
      'INSERT INTO projects (id, name, root_path, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)',
    ).run('prj_legacydup', a.name, a.created_at, a.created_at);
    assert.throws(
      () => resolveProject(f.db, 'myproj', { mode: 'read' }),
      (error: unknown) => {
        assert.ok(error instanceof HiveMemError);
        assert.equal(error.code, 'AMBIGUOUS_PROJECT');
        const candidates = (error.detail as { candidates: unknown[] }).candidates;
        assert.equal(candidates.length, 2);
        return true;
      },
    );
    // id 引用不受影响
    assert.equal(resolveProject(f.db, a.id, { mode: 'read' }).id, a.id);
  } finally {
    f.cleanup();
  }
});
