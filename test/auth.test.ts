import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { verifyToken, startHub } from '../src/http.js';
import { fixture } from './helpers.js';

function fakeRequest(authorization?: string): IncomingMessage {
  return { headers: { ...(authorization ? { authorization } : {}) } } as unknown as IncomingMessage;
}

test('verifyToken：无 token 放行；正确 Bearer 通过；错误拒绝', () => {
  assert.equal(verifyToken(fakeRequest(), undefined), true);
  assert.equal(verifyToken(fakeRequest('Bearer abc'), undefined), true);
  const token = 'a'.repeat(64);
  assert.equal(verifyToken(fakeRequest(`Bearer ${token}`), token), true);
  assert.equal(verifyToken(fakeRequest(`Bearer ${'b'.repeat(64)}`), token), false);
  assert.equal(verifyToken(fakeRequest(`bearer ${token}`), token), false);
  assert.equal(verifyToken(fakeRequest(), token), false);
  assert.equal(verifyToken(fakeRequest('Basic abc'), token), false);
});

test('hub 认证端到端：401 拒绝、Bearer 放行、Web UI 免认证', async () => {
  const f = fixture();
  const token = 'c'.repeat(64);
  const server = await startHub({ db: f.db, port: 0, token });
  try {
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    const noAuth = await fetch(`${base}/api/projects`);
    assert.equal(noAuth.status, 401);

    const wrong = await fetch(`${base}/api/projects`, { headers: { Authorization: 'Bearer wrong' } });
    assert.equal(wrong.status, 401);

    const good = await fetch(`${base}/api/projects`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(good.status, 200);
    const body = (await good.json()) as { projects: unknown[] };
    assert.ok(Array.isArray(body.projects));

    const mcpNoAuth = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(mcpNoAuth.status, 401);

    const web = await fetch(`${base}/`);
    assert.equal(web.status, 200);
    const html = await web.text();
    assert.ok(html.includes('HiveMem'));
  } finally {
    server.close();
    server.closeAllConnections?.();
    f.cleanup();
  }
});
