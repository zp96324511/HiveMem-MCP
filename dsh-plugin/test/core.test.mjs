import test from 'node:test';
import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import {
  BriefCache,
  DEFAULT_CONFIG,
  basenameOf,
  briefBudgetFor,
  briefHeader,
  buildBriefUrl,
  fetchBrief,
  frameBrief,
  notFoundNotice,
  oversizeNotice,
  resolveDevice,
  resolveProjectName,
} from '../lib/core.js';

/**
 * Pure-core tests for the DSH injection plugin. No harness, no network: the
 * HTTP read is exercised through an injected fetch so the URL, headers and
 * timeout plumbing are verified without a live hub (the real hub round-trip
 * lives in the main suite's test/dsh-plugin.test.ts).
 */

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const briefSnapshot = (overrides = {}) => ({
  project: 'proj',
  text: '- [mem_1] v2 决策：SQLite',
  truncated: false,
  total: 1,
  shown: 1,
  fetchedAt: Date.now(),
  ...overrides,
});

test('项目名解析：显式优先，auto 取工作目录名（兼容 Windows 路径）', () => {
  assert.equal(basenameOf('C:\\data\\projects\\HiveMem-MCP'), 'HiveMem-MCP');
  assert.equal(basenameOf('/home/me/work/hivemem'), 'hivemem');
  assert.equal(basenameOf('C:\\data\\projects\\HiveMem-MCP\\'), 'HiveMem-MCP');
  assert.equal(basenameOf(''), '');

  assert.equal(resolveProjectName('HiveMem-MCP', 'C:\\x\\y'), 'HiveMem-MCP');
  assert.equal(resolveProjectName('', '/srv/app'), 'app');
  assert.equal(resolveProjectName('auto', '/srv/app'), 'app');
  assert.equal(resolveProjectName('  auto  ', '/srv/app'), 'app');
});

test('设备标识：显式值优先，auto 回落到主机名', () => {
  assert.equal(resolveDevice('win10-desk'), 'win10-desk');
  assert.equal(resolveDevice('  mac-mini  '), 'mac-mini');
  assert.equal(resolveDevice('auto'), hostname());
  assert.equal(resolveDevice(''), hostname());
  assert.equal(resolveDevice(undefined), hostname());
});

test('URL 构造：尾斜杠与 /mcp 后缀都能兼容，项目名被编码，budget 可选', () => {
  assert.equal(buildBriefUrl('http://127.0.0.1:7660', 'proj'), 'http://127.0.0.1:7660/api/brief?project=proj');
  assert.equal(buildBriefUrl('http://127.0.0.1:7660/', 'proj'), 'http://127.0.0.1:7660/api/brief?project=proj');
  assert.equal(
    buildBriefUrl('https://hivemem.zpzp.xyz/mcp', 'proj'),
    'https://hivemem.zpzp.xyz/api/brief?project=proj',
  );
  assert.equal(buildBriefUrl('https://h.zpzp.xyz/', 'my proj&x'), 'https://h.zpzp.xyz/api/brief?project=my%20proj%26x');
  assert.equal(
    buildBriefUrl('https://hivemem.zpzp.xyz', 'proj', 2470),
    'https://hivemem.zpzp.xyz/api/brief?project=proj&budget=2470',
  );
});

test('预算换算：请求预算 = 上限 − 头部，并夹在 /api/brief 接受的区间', () => {
  const header = briefHeader('proj').length;
  assert.equal(briefBudgetFor(2800), 2800 - header);
  assert.equal(briefBudgetFor(400), 512, 'a ceiling smaller than the server minimum still asks for 512');
  assert.equal(briefBudgetFor(100_000), 8000, 'the server clamps at 8000; do not ask beyond it');
  assert.equal(briefBudgetFor(0), DEFAULT_CONFIG.maxChars - header, 'no ceiling means the default one');
});

test('frameBrief：带来源与「历史不覆盖当前指示」的边界声明，且从不裁剪', () => {
  const framed = frameBrief(briefSnapshot(), 2800);
  assert.equal(framed.oversize, false);
  assert.match(framed.text, /HiveMem 项目简报/);
  assert.match(framed.text, /project=proj/);
  assert.match(framed.text, /当前用户指示始终优先/);
  // The injected block must say it is already there: the MCP instructions ask
  // for a bootstrap "at session start", and without this line the model would
  // fetch a second identical brief on top of the injected one.
  assert.match(framed.text, /不必再调 memory_bootstrap/);
  // HTTP hubs cannot infer the client's cwd, so the header repeats the exact
  // project value every memory_* call must carry.
  assert.match(framed.text, /调用任何 memory_\* 工具时都要带 project="proj"/);
  assert.match(framed.text, /PROJECT_REQUIRED/);
  assert.match(framed.text, /- \[mem_1\] v2 决策：SQLite/);
  assert.doesNotMatch(framed.text, /截断/, 'a complete brief carries no truncation footer');

  // The plugin must not re-clip: a short ceiling surfaces as an oversize result
  // instead of a silently shortened body.
  const big = briefSnapshot({ text: 'y'.repeat(3000) });
  const oversize = frameBrief(big, 1000);
  assert.equal(oversize.oversize, true);
  assert.equal(oversize.text, '');
  assert.equal(oversize.chars > 1000, true);

  assert.equal(frameBrief({ project: 'p', text: '   ' }, 2800).text, '', 'an empty brief injects nothing');

  // Older hubs may not append their own footer; the plugin then does.
  const truncated = frameBrief(briefSnapshot({ text: 'x', truncated: true }), 2800);
  assert.match(truncated.text, /已截断/);

  // A hub that already wrote a footer is not given a second one.
  const withFooter = frameBrief(briefSnapshot({ text: 'x\n（已截断：3 条中列出 1 条）', truncated: true }), 2800);
  assert.equal((withFooter.text.match(/已截断/g) ?? []).length, 1);
});

test('提示文本：缺项目时给出可执行的下一步，而不是一句错误', () => {
  const missing = notFoundNotice('HiveMem-MCP');
  assert.match(missing, /「HiveMem-MCP」尚未注册/);
  assert.match(missing, /memory_bootstrap\(project="HiveMem-MCP"\)/);
  assert.equal(missing.split('\n').length, 2, 'no directory line when the caller has no directory to name');

  // With the session directory the notice explains where the name came from —
  // the difference between "unregistered" and "unregistered, and here is why
  // the name looks wrong".
  const missingWithCwd = notFoundNotice('win10', 'C:\\Users\\win10');
  assert.match(missingWithCwd, /项目名取自会话目录：C:\\Users\\win10/);
  assert.ok(
    missingWithCwd.startsWith(notFoundNotice('win10')),
    'the directory line is appended, not substituted',
  );

  const oversize = oversizeNotice('p', 3000, 1000);
  assert.match(oversize, /超出注入预算（3000 > 1000 字符）/);
  assert.match(oversize, /memory_bootstrap/);
});

test('fetchBrief：带 Accept/Bearer/设备/工具头，非 2xx 带 code 抛出', async () => {
  const seen = [];
  const ok = await fetchBrief({
    baseUrl: 'https://h.example',
    project: 'proj',
    token: 'tok',
    device: 'win10-desk',
    agent: 'dsh',
    budget: 2470,
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return jsonResponse({
        project: { id: 'p1', name: 'proj' },
        rendered: '- brief',
        truncated: true,
        total: 9,
        shown: 3,
        omitted: { budget: 2, priority: 4 },
      });
    },
  });
  assert.equal(seen[0].url, 'https://h.example/api/brief?project=proj&budget=2470');
  assert.equal(seen[0].init.headers.authorization, 'Bearer tok');
  assert.equal(seen[0].init.headers.accept, 'application/json');
  assert.equal(seen[0].init.headers['x-hivemem-device'], 'win10-desk');
  assert.equal(seen[0].init.headers['x-hivemem-agent'], 'dsh');
  assert.equal(ok.text, '- brief');
  assert.equal(ok.truncated, true);
  assert.equal(ok.project, 'proj');
  assert.deepEqual(ok.omitted, { budget: 2, priority: 4 });

  // Headers are omitted when no scope identity is configured (the hub then
  // falls back to its defaults instead of receiving empty labels).
  const bare = [];
  await fetchBrief({
    baseUrl: 'https://h.example',
    project: 'proj',
    fetchImpl: async (url, init) => {
      bare.push(init);
      return jsonResponse({ rendered: '- b' });
    },
  });
  assert.equal('x-hivemem-device' in bare[0].headers, false);
  assert.equal('x-hivemem-agent' in bare[0].headers, false);

  await assert.rejects(
    () =>
      fetchBrief({
        baseUrl: 'https://h.example',
        project: 'proj',
        fetchImpl: async () => jsonResponse({ error: '未找到该项目', code: 'PROJECT_NOT_FOUND' }, 404),
      }),
    (error) => {
      assert.match(error.message, /HTTP 404 PROJECT_NOT_FOUND/);
      assert.equal(error.status, 404);
      assert.equal(error.code, 'PROJECT_NOT_FOUND');
      return true;
    },
  );
  await assert.rejects(
    () =>
      fetchBrief({
        baseUrl: 'https://h.example',
        project: 'proj',
        fetchImpl: async () => jsonResponse({ nope: true }),
      }),
    /no rendered brief/,
  );
  await assert.rejects(
    () => fetchBrief({ baseUrl: 'https://h.example', project: '', fetchImpl: async () => jsonResponse({}) }),
    /cannot resolve a project/,
  );
});

test('fetchBrief：超时用 TimeoutError 报出来，而不是裸 AbortError', async () => {
  const hanging = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'TimeoutError';
        reject(error);
      });
    });
  await assert.rejects(
    () => fetchBrief({ baseUrl: 'https://h.example', project: 'p', timeoutMs: 20, fetchImpl: hanging }),
    /timeout after 20ms/,
  );
});

test('BriefCache：TTL 内命中缓存，过期后重取；同一项目并发只发一次请求', async () => {
  let calls = 0;
  const cache = new BriefCache({
    ttlMs: 50,
    maxChars: 2800,
    fetchBriefImpl: async ({ project }) => {
      calls += 1;
      return briefSnapshot({ project, text: `- 第 ${calls} 次` });
    },
  });

  assert.equal(cache.text(), '', 'nothing is injected before the first read');
  await cache.ensure('proj');
  assert.equal(calls, 1);
  assert.match(cache.text(), /第 1 次/);

  await cache.ensure('proj');
  assert.equal(calls, 1, 'within TTL the cached brief is served');
  assert.equal(cache.stats.hits, 1);

  const [a, b] = await Promise.all([cache.ensure('other'), cache.ensure('other')]);
  assert.equal(calls, 2, 'concurrent refreshes for one project collapse into one request');
  assert.equal(a.project, 'other');
  assert.equal(b.project, 'other');

  await new Promise((resolve) => setTimeout(resolve, 60));
  await cache.ensure('proj');
  assert.equal(calls, 3, 'an expired entry is refetched (project also changed)');
});

test('BriefCache：请求服务端预算，并带上设备/工具身份', async () => {
  const calls = [];
  const cache = new BriefCache({
    maxChars: 2800,
    device: 'win10-desk',
    agent: 'dsh',
    fetchBriefImpl: async (options) => {
      calls.push(options);
      return briefSnapshot();
    },
  });
  await cache.ensure('proj');
  assert.equal(calls[0].budget, briefBudgetFor(2800));
  assert.equal(calls[0].device, 'win10-desk');
  assert.equal(calls[0].agent, 'dsh');
});

test('BriefCache：预算按实际项目名的表头长度扣减，而不是占位符 proj', async () => {
  const calls = [];
  const project = 'a-very-long-project-name';
  const cache = new BriefCache({
    maxChars: 2800,
    fetchBriefImpl: async (options) => {
      calls.push(options);
      return briefSnapshot({ project });
    },
  });
  await cache.ensure(project);
  assert.equal(calls[0].budget, briefBudgetFor(2800, briefHeader(project).length));
  assert.ok(
    calls[0].budget < briefBudgetFor(2800),
    'a longer header must leave less room for the brief',
  );
});

test('BriefCache：未注册项目注入可见提示（而不是空串），且不抛错', async () => {
  const notices = [];
  const cache = new BriefCache({
    ttlMs: 0,
    fetchBriefImpl: async () => {
      const error = new Error('hivemem: GET … → HTTP 404 PROJECT_NOT_FOUND');
      error.code = 'PROJECT_NOT_FOUND';
      error.status = 404;
      throw error;
    },
    onNotice: (kind, project) => notices.push({ kind, project }),
  });

  await cache.ensure('brand-new');
  assert.match(cache.text(), /「brand-new」尚未注册/);
  assert.match(cache.text(), /memory_bootstrap/);
  assert.equal(cache.stats.missing, 1);
  assert.equal(cache.stats.failures, 1, 'a missing project is still counted as a failed read');
  assert.deepEqual(notices, [{ kind: 'missing', project: 'brand-new' }]);
});

test('BriefCache：简报超出主机预算时降级为提示，不裁剪正文', async () => {
  const notices = [];
  const cache = new BriefCache({
    maxChars: 600,
    fetchBriefImpl: async () => briefSnapshot({ text: 'y'.repeat(2000) }),
    onNotice: (kind) => notices.push(kind),
  });
  await cache.ensure('proj');
  assert.match(cache.text(), /超出注入预算/);
  assert.match(cache.text(), /memory_bootstrap/);
  assert.doesNotMatch(cache.text(), /yyyy/, 'the body is skipped, never clipped');
  assert.equal(cache.stats.oversize, 1);
  assert.deepEqual(notices, ['oversize']);
});

test('BriefCache：失败 fail-open，保留上一次成功的简报并记录错误', async () => {
  let mode = 'ok';
  const errors = [];
  const cache = new BriefCache({
    ttlMs: 0,
    fetchBriefImpl: async ({ project }) => {
      if (mode === 'fail') throw new Error('hub down');
      return briefSnapshot({ project, text: '- 可用' });
    },
    onError: (error) => errors.push(String(error.message)),
  });

  await cache.ensure('proj');
  assert.match(cache.text(), /可用/);

  mode = 'fail';
  const afterFailure = await cache.ensure('proj');
  assert.match(afterFailure.rendered, /可用/, 'stale text survives a failed refresh');
  assert.equal(cache.stats.failures, 1);
  assert.deepEqual(errors, ['hub down']);

  // An empty brief clears the injection rather than injecting a banner-only block.
  const empty = new BriefCache({
    fetchBriefImpl: async ({ project }) => briefSnapshot({ project, text: '' }),
  });
  await empty.ensure('proj');
  assert.equal(empty.text(), '');
});

test('默认配置：指向本机 hub，预算与超时可控', () => {
  assert.equal(DEFAULT_CONFIG.baseUrl, 'http://127.0.0.1:7660');
  assert.ok(DEFAULT_CONFIG.maxChars > 2600 && DEFAULT_CONFIG.maxChars <= 4000);
  assert.ok(DEFAULT_CONFIG.timeoutMs <= 5000);
  assert.equal(DEFAULT_CONFIG.device, 'auto');
  assert.equal(DEFAULT_CONFIG.agent, 'dsh');
});
