/**
 * One-shot import of Claude Code session transcripts (JSONL) as episodic
 * memories. Deterministic — no LLM involved:
 *
 * - one memory per session file; title = first real user prompt
 * - content = digest of user prompts + final assistant reply
 * - session_id = the JSONL filename (uuid), making re-imports idempotent
 * - created_at/updated_at preserved from the transcript timestamps so
 *   recency scoring stays honest
 *
 * Usage: hivemem import-claude <file-or-dir> --project <ref> [--ttl-days N]
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Db } from './db.js';
import { resolveProject } from './projects.js';
import { writeMemory } from './store.js';
import { clip } from './util.js';

interface TranscriptEntry {
  type?: string;
  isMeta?: boolean;
  timestamp?: string;
  message?: { content?: unknown };
}

function extractTexts(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const part of content) {
    if (
      typeof part === 'object' &&
      part !== null &&
      (part as { type?: string }).type === 'text' &&
      typeof (part as { text?: unknown }).text === 'string'
    ) {
      out.push((part as { text: string }).text);
    }
  }
  return out;
}

function buildDigest(userTexts: string[], assistantTexts: string[]): string {
  const parts: string[] = [];
  if (userTexts.length) {
    const lines = userTexts
      .slice(0, 10)
      .map((text, i) => `${i + 1}. ${clip(text.replace(/\s+/g, ' '), 200)}`);
    if (userTexts.length > 10) lines.push(`（共 ${userTexts.length} 条请求）`);
    parts.push(`## 用户请求\n${lines.join('\n')}`);
  }
  const lastReply = assistantTexts[assistantTexts.length - 1];
  if (lastReply) parts.push(`## 最终回复\n${clip(lastReply, 800)}`);
  return parts.join('\n\n') || '（空会话）';
}

export interface ImportOptions {
  src: string;
  projectRef: string;
  /** 0 disables expiry; default 90 days. */
  ttlDays?: number;
  limit?: number;
}

export interface ImportResult {
  files: number;
  imported: number;
  skipped: number;
  /** Lines that failed JSON parsing — reported, never silently dropped (MCP Ref pattern). */
  unreadable: number;
}

const SOURCE_AGENT = 'claude-code';

export function importClaudeSessions(db: Db, options: ImportOptions): ImportResult {
  const project = resolveProject(db, options.projectRef, { mode: 'write' });
  const stat = statSync(options.src);
  const files = stat.isFile()
    ? [path.resolve(options.src)]
    : readdirSync(options.src)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => path.join(options.src, f))
        .sort();
  const selected = options.limit ? files.slice(0, options.limit) : files;
  const ttlDays = options.ttlDays ?? 90;

  let imported = 0;
  let skipped = 0;
  let unreadable = 0;
  for (const file of selected) {
    const sessionId = path.basename(file, '.jsonl');
    const already = db
      .prepare('SELECT 1 AS x FROM memories WHERE session_id = ? AND source_agent = ? LIMIT 1')
      .get(sessionId, SOURCE_AGENT);
    if (already) {
      skipped++;
      continue;
    }

    const userTexts: string[] = [];
    const assistantTexts: string[] = [];
    let firstTs: string | undefined;
    let lastTs: string | undefined;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let entry: TranscriptEntry;
      try {
        entry = JSON.parse(line) as TranscriptEntry;
      } catch {
        unreadable++;
        continue;
      }
      if (entry.isMeta) continue;
      if (entry.timestamp) {
        lastTs = entry.timestamp;
        firstTs ??= entry.timestamp;
      }
      const texts = extractTexts(entry.message?.content);
      if (entry.type === 'user') {
        for (const text of texts) {
          if (!text.startsWith('<')) userTexts.push(text);
        }
      } else if (entry.type === 'assistant') {
        assistantTexts.push(...texts);
      }
    }

    if (!userTexts.length && !assistantTexts.length) {
      skipped++;
      continue;
    }
    writeMemory(db, {
      projectId: project.id,
      title: clip(userTexts[0] ?? assistantTexts[0] ?? sessionId, 80),
      content: buildDigest(userTexts, assistantTexts),
      kind: 'episodic',
      tags: ['imported', SOURCE_AGENT],
      importance: 0.3,
      sourceAgent: SOURCE_AGENT,
      sessionId,
      ttlDays: ttlDays > 0 ? ttlDays : undefined,
      createdAt: firstTs,
      updatedAt: lastTs,
    });
    imported++;
  }
  return { files: selected.length, imported, skipped, unreadable };
}
