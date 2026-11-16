/**
 * `hivemem setup --agent dsh` — write the MCP client entry into the local
 * DeepSeek Harness configuration (Memorix's setup pattern). Idempotent: an
 * existing mcp-hivemem entry in either the home-level or profile-level patch
 * file is detected and reported instead of duplicated.
 *
 * `hivemem doctor` — health checks: database, hub reachability, MCP endpoint,
 * embedding index, and agent configuration presence.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { openDb } from './db.js';
import { embeddingStats, projectStats } from './store.js';

export interface SetupResult {
  written: boolean;
  file: string;
  note: string;
  /** Header names added to an existing entry by the upgrade path. */
  upgraded?: string[];
}

const ENTRY_ID = 'mcp-hivemem';

function dshHome(): string {
  return process.env.DSH_HOME?.trim() || path.join(homedir(), '.dsh');
}

function patchFiles(dshHomeDir: string): string[] {
  return [
    path.join(dshHomeDir, 'cordis.patch.yml'),
    path.join(dshHomeDir, 'profiles', 'web', 'cordis.patch.yml'),
  ];
}

const entryYaml = (port: number, agent: string, headers?: { token?: string; device?: string }, url?: string) => {
  const finalUrl = url ?? `http://127.0.0.1:${port}/mcp`;
  const extra = [
    ...(headers?.device ? [`          X-HiveMem-Device: ${headers.device}`] : []),
    ...(headers?.token ? [`          Authorization: Bearer ${headers.token}`] : []),
  ];
  return `
# HiveMem 记忆中枢（hivemem setup --agent dsh 写入）
- insert:
    - id: ${ENTRY_ID}
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: hivemem
        transport: streamable-http
        url: ${finalUrl}
        headers:
          X-HiveMem-Agent: ${agent}${extra.length ? '\n' + extra.join('\n') : ''}
`;
};

/**
 * Upgrade an existing hand-written or older mcp-hivemem entry in place:
 * swap the URL and/or add missing headers right after its X-HiveMem-Agent
 * line, with matching indentation. Neighboring patch entries are untouched.
 */
function upgradeEntry(
  text: string,
  wanted: { url?: string; headers?: Array<[string, string]> },
): { text: string; changed: string[] } {
  const blockMatch = text.match(/(- id: mcp-hivemem[\s\S]*?)(?=\n- (?:insert|override|remove|replace)|$)/);
  if (!blockMatch) return { text, changed: [] };
  let block = blockMatch[1];
  const changed: string[] = [];
  if (wanted.url) {
    const urlLine = block.match(/^(\s*)url: .*$/m);
    if (urlLine && urlLine[0].trim() !== `url: ${wanted.url}`) {
      block = block.replace(urlLine[0], `${urlLine[1]}url: ${wanted.url}`);
      changed.push('url');
    }
  }
  if (wanted.headers?.length) {
    const agentLine = block.match(/^(\s*)X-HiveMem-Agent:.*$/m);
    if (agentLine) {
      const indent = agentLine[1];
      const anchor = agentLine[0];
      for (const [name, value] of wanted.headers) {
        if (new RegExp(`^\\s*${name}:`, 'm').test(block)) continue;
        block = block.replace(anchor, `${anchor}\n${indent}${name}: ${value}`);
        changed.push(name);
      }
    }
  }
  if (changed.length === 0) return { text, changed };
  return { text: text.replace(blockMatch[1], block), changed };
}

/**
 * Configure the local DSH to connect to the HiveMem hub. Idempotent; when
 * token/device headers are requested and the entry already exists, missing
 * headers are upgraded in place instead of duplicating the entry.
 */
export function setupDsh(options?: {
  port?: number;
  agent?: string;
  /** Per-user MCP token (multi-user mode) or the hub token (legacy mode). */
  token?: string;
  /** Explicit device name; omit to rely on the hostname fallback. */
  device?: string;
  /** Custom hub URL (e.g. https://hivemem.zpzp.xyz/mcp); defaults to local 127.0.0.1. */
  url?: string;
}): SetupResult {
  const port = options?.port ?? 7660;
  const agent = options?.agent ?? 'dsh';
  const home = dshHome();
  const files = patchFiles(home);

  for (const file of files) {
    if (!existsSync(file) || !readFileSync(file, 'utf8').includes(ENTRY_ID)) continue;
    const wantedHeaders: Array<[string, string]> = [];
    if (options?.device?.trim()) wantedHeaders.push(['X-HiveMem-Device', options.device.trim()]);
    if (options?.token?.trim()) wantedHeaders.push(['Authorization', `Bearer ${options.token.trim()}`]);
    const { text, changed } = upgradeEntry(readFileSync(file, 'utf8'), {
      url: options?.url?.trim() || undefined,
      headers: wantedHeaders,
    });
    if (changed.length === 0) {
      return { written: false, file, note: '已存在 mcp-hivemem 配置，请求的变更均已具备' };
    }
    writeFileSync(file, text, 'utf8');
    return {
      written: false,
      file,
      note: `已更新现有 mcp-hivemem 条目：${changed.join('、')}；重启 DSH 或重载配置后生效`,
      upgraded: changed,
    };
  }

  const target = files[0];
  let text = existsSync(target) ? readFileSync(target, 'utf8') : '';
  const entry = entryYaml(port, agent, { token: options?.token, device: options?.device }, options?.url?.trim() || undefined);
  if (/^\[\]\s*$/m.test(text)) {
    text = text.replace(/^\[\]\s*$/m, entry.trimStart());
  } else {
    text = text.trimEnd() + '\n' + entry;
  }
  writeFileSync(target, text, 'utf8');
  return { written: true, file: target, note: '已写入 insert 条目；重启 DSH 或重载配置后生效' };
}

export interface DoctorReport {
  db: { ok: boolean; path: string; projects: number; memories: number; detail?: string };
  hub: { ok: boolean; url: string; detail?: string };
  mcp: { ok: boolean; url: string; server?: string; detail?: string };
  embeddings: { model: string | null; dim: number | null; embedded: number; total: number };
  dshConfig: { found: boolean; file?: string };
}

/** Health checks for the local HiveMem deployment. */
export async function runDoctor(options: { dbPath: string; port?: number }): Promise<DoctorReport> {
  const port = options.port ?? 7660;
  const base = `http://127.0.0.1:${port}`;
  const dbPath = options.dbPath;

  let dbReport: DoctorReport['db'] = {
    ok: false, path: dbPath, projects: 0, memories: 0,
  };
  let embeddings: DoctorReport['embeddings'] = { model: null, dim: null, embedded: 0, total: 0 };
  try {
    const db = openDb(dbPath);
    const stats = projectStats(db);
    dbReport = { ok: true, path: dbPath, projects: stats.projects?.length ?? 0, memories: stats.total };
    embeddings = embeddingStats(db);
    db.close();
  } catch (error) {
    dbReport = { ok: false, path: dbPath, projects: 0, memories: 0, detail: error instanceof Error ? error.message : String(error) };
  }

  let hub: DoctorReport['hub'] = { ok: false, url: base };
  let mcp: DoctorReport['mcp'] = { ok: false, url: `${base}/mcp` };
  try {
    const res = await fetch(`${base}/api/stats`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      hub = { ok: true, url: base };
    } else {
      hub = { ok: false, url: base, detail: `HTTP ${res.status}` };
    }
  } catch (error) {
    hub = { ok: false, url: base, detail: error instanceof Error ? error.message.slice(0, 120) : 'unreachable' };
  }
  if (hub.ok) {
    try {
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'doctor', version: '0' } },
        }),
        signal: AbortSignal.timeout(5000),
      });
      const json = (await res.json()) as { result?: { serverInfo?: { name?: string } } };
      mcp = res.ok && json.result?.serverInfo?.name
        ? { ok: true, url: `${base}/mcp`, server: json.result.serverInfo.name }
        : { ok: false, url: `${base}/mcp`, detail: `HTTP ${res.status}` };
    } catch (error) {
      mcp = { ok: false, url: `${base}/mcp`, detail: error instanceof Error ? error.message.slice(0, 120) : 'initialize failed' };
    }
  }

  let dshConfig: DoctorReport['dshConfig'] = { found: false };
  for (const file of patchFiles(dshHome())) {
    if (existsSync(file) && readFileSync(file, 'utf8').includes(ENTRY_ID)) {
      dshConfig = { found: true, file };
      break;
    }
  }

  return { db: dbReport, hub, mcp, embeddings, dshConfig };
}
