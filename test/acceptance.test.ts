import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startHub } from '../src/http.js';
import { apply as applyBriefPlugin } from '../dsh-plugin/lib/index.js';

/**
 * End-to-end acceptance: the claim HiveMem makes is "a NEW session recalls what
 * an earlier session recorded". Everything else (unit tests, MCP round trips) is
 * in-process and cannot prove that claim, so this file spawns real processes
 * against one database file and checks the two delivery paths an agent has:
 *
 *   1. the MCP tool surface (memory_bootstrap / memory_read) — explicit recall;
 *   2. the DSH pre-step injection — recall WITHOUT calling a tool.
 *
 * A stubbed "model" plays the agent: fixed arguments, deterministic order. No
 * network, no LLM, no timing luck.
 */

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, '..');
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const entry = path.join(repoRoot, 'src', 'index.ts');

interface Payload {
  error?: { code: string; message: string };
  memory?: {
    id: string;
    content: string;
    version: number;
    evidence?: Array<{ kind: string; locator: string; quote?: string | null }>;
  };
  rendered?: string;
  history?: { current_version: number; revisions: Array<{ version: number; action: string }> };
  [key: string]: any;
}

const payloadOf = (result: unknown): Payload => {
  const r = result as { content?: Array<{ type: string; text: string }> };
  assert.ok(r.content?.[0]?.text, 'tool result must carry text content');
  return JSON.parse(r.content[0].text) as Payload;
};

/** One agent session: a real `hivemem serve` child process speaking MCP. */
async function openSession(dbPath: string, cwd: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsxCli, entry, 'serve'],
    cwd,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      ),
      HIVEMEM_DB: dbPath,
      HIVEMEM_AGENT: 'acceptance',
      HIVEMEM_EMBEDDING_URL: '',
    },
  });
  const client = new Client({ name: 'acceptance-agent', version: '0.0.1' });
  await client.connect(transport);
  return {
    client,
    call: async (name: string, args: Record<string, unknown> = {}) =>
      payloadOf(await client.callTool({ name, arguments: args })),
    close: async () => {
      await client.close();
    },
  };
}

/**
 * Windows keeps the SQLite artefact locked for a beat after the last child
 * exits, so a temp-dir delete can fail spuriously right after `close()`.
 * Retry briefly, then leave the directory to the OS rather than failing a test
 * over cleanup.
 */
function cleanupDir(dir: string): void {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the temp directory outlives the test; nothing depends on it */
  }
}

test('验收：上一个会话写入的决策，新进程的新会话能召回（MCP + 前置注入两条路都通）', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hivemem-accept-'));
  const dbPath = path.join(dir, 'hivemem.db');
  const projDir = path.join(dir, 'myproj');
  const projectName = path.basename(projDir);
  const { mkdirSync } = await import('node:fs');
  mkdirSync(projDir);

  try {
    // ---- session 1: the agent records a decision with its provenance --------
    const s1 = await openSession(dbPath, projDir);
    let memoryId = '';
    try {
      const boot = await s1.call('memory_bootstrap');
      assert.ok(boot.project?.id, 'bootstrap resolves and registers the project for this cwd');

      const write = await s1.call('memory_write', {
        title: '数据库选型：单文件 SQLite',
        content: '理由：零运维、单文件、WAL 足够；不引入服务端数据库。',
        kind: 'decision',
        pinned: true,
        evidence: [
          { kind: 'prompt', locator: 'm00053', quote: '开始规划和实施值得抄的 5 个点' },
          { kind: 'file', locator: 'src/db.ts:1' },
        ],
      });
      assert.ok(write.memory?.id);
      memoryId = write.memory.id;
      assert.equal(write.memory.version, 1);

      const revised = await s1.call('memory_update', {
        id: memoryId,
        content: '理由：零运维、单文件、WAL 足够；不引入服务端数据库。补充：备份就是复制文件。',
        expected_version: 1,
      });
      assert.equal(revised.memory?.version, 2);

      // A stale writer is rejected instead of clobbering the revision.
      const stale = await s1.call('memory_update', {
        id: memoryId,
        content: '旧内容覆盖',
        expected_version: 1,
      });
      assert.equal(stale.error?.code, 'REVISION_CONFLICT');
    } finally {
      await s1.close();
    }

    // ---- session 2: a brand-new process, same database ---------------------
    const s2 = await openSession(dbPath, projDir);
    try {
      const boot = await s2.call('memory_bootstrap');
      assert.equal(boot.created, undefined, 'an existing project is not re-created');      assert.match(
        String(boot.rendered),
        /数据库选型：单文件 SQLite/,
        'a new session must see the pinned decision in its brief without searching',
      );
      assert.match(String(boot.rendered), /备份就是复制文件/, 'the revised body is what gets recalled');

      const read = await s2.call('memory_read', { id: memoryId });
      assert.equal(read.memory?.version, 2);
      assert.deepEqual(
        read.memory?.evidence?.map((e) => e.kind),
        ['prompt', 'file'],
        'provenance survives across processes',
      );

      // History is addressable, not just logged.
      const at1 = await s2.call('memory_read', { id: memoryId, at_version: 1 });
      assert.equal(at1.memory?.version, 1);
      assert.doesNotMatch(String(at1.memory?.content), /备份就是复制文件/);
      const history = await s2.call('memory_read', { id: memoryId, include_history: true });
      assert.equal(history.history?.current_version, 2);
      assert.deepEqual(history.history?.revisions.map((r) => r.version), [1]);

      // Resolve the conflict the way the tool description says to: re-read, retry.
      const retried = await s2.call('memory_write', {
        title: '数据库选型：单文件 SQLite',
        content: '理由：零运维、单文件、WAL 足够；不引入服务端数据库。补充：备份就是复制文件。补充：迁移走 schema 版本号。',
        kind: 'decision',
        topic_key: 'arch/db',
        expected_version: 1,
      });
      // No topic_key on the original row, so this writes a NEW memory; it must
      // not have been silently merged into the versioned one.
      assert.notEqual(retried.memory?.id, memoryId);
    } finally {
      await s2.close();
    }

    // ---- delivery path 2: injection, with no tool call at all --------------
    const server = await startHub({ dbPath, port: 0 });
    const port = (server.address() as { port: number }).port;
    try {
      const handlers: Array<(payload: any, next: () => Promise<{ kind: 'enter'; messages: unknown[] }>) => Promise<unknown>> = [];
      let contribution: { name: string; text: () => string } | null = null;
      // Same shape as a real cordis context: the directory service is reached
      // through ctx.reflect (an un-injected ctx.workingDirectory would throw),
      // and the session carries the directory the session was created in.
      const session = { header: { cwd: projDir } };
      applyBriefPlugin(
        {
          logger: { info: () => {}, warn: () => {}, error: () => {} },
          on: (_event: string, fn: never) => {
            handlers.push(fn);
            return () => {};
          },
          systemPrompt: {
            context: (c: { name: string; text: () => string }) => {
              contribution = c;
              return () => {};
            },
          },
          reflect: {
            get: (name: string) =>
              name === 'workingDirectory' ? { get: (s: { header?: { cwd?: string } }) => s?.header?.cwd } : undefined,
          },
        } as never,
        { baseUrl: `http://127.0.0.1:${port}`, ttlMs: 0 },
      );
      assert.ok(handlers.length === 1, 'plugin registers exactly one pre-step hook');
      assert.equal(contribution?.text(), '', 'nothing is injected before the first step');
      await handlers[0]({ agent: { session }, turn: 1, step: 1 }, async () => ({
        kind: 'enter' as const,
        messages: [],
      }));
      const injected = contribution?.text() ?? '';
      assert.match(injected, /HiveMem 项目简报/);
      assert.match(injected, new RegExp(`project=${projectName}`));
      assert.match(injected, /数据库选型：单文件 SQLite/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    // ---- delivery path 3: the CLI fallback renders the same text -----------
    const { stdout } = await execFileAsync(process.execPath, [tsxCli, entry, 'brief', '--db', dbPath, '--project', projectName], {
      cwd: repoRoot,
      timeout: 60_000,
    });
    assert.match(stdout, /数据库选型：单文件 SQLite/);
    assert.match(stdout, /备份就是复制文件/);
  } finally {
    cleanupDir(dir);
  }
});
