import type { Db } from './db.js';
import { ensureUserProject, USER_PROJECT_ID } from './projects.js';
import { scopeCondition, scopeOf, userProjectIds, type Scope, type ScopeContext } from './scope.js';
import { HiveMemError, clamp01, clip, newMemoryId, nowIso, runeLength } from './util.js';

export const KINDS = ['fact', 'decision', 'preference', 'procedure', 'episodic', 'snippet'] as const;
export type Kind = (typeof KINDS)[number];

export const STATUSES = ['active', 'archived', 'superseded'] as const;
export type Status = (typeof STATUSES)[number];

/**
 * Typed provenance locator. A memory is a conclusion; evidence says where the
 * conclusion came from (the prompt, the file, the command, the URL), so a later
 * reader can re-check it instead of trusting the summary.
 */
export const EVIDENCE_KINDS = ['prompt', 'session', 'file', 'url', 'command', 'artifact', 'note'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface Evidence {
  kind: EvidenceKind;
  /** Where to look: session id, path[:line], URL, command, artifact ref, free text. */
  locator: string;
  /** Optional short verbatim excerpt (never the whole document). */
  quote?: string | null;
  /** When the evidence was observed (ISO-8601); defaults to write time. */
  at?: string | null;
}

/** Upper bound on evidence per memory — provenance, not a transcript. */
export const MAX_EVIDENCE = 12;
/** Upper bound on one evidence locator / quote (code points). */
export const MAX_EVIDENCE_TEXT = 500;
export const MAX_EVIDENCE_QUOTE = 300;

export interface Memory {
  id: string;
  project_id: string;
  kind: Kind;
  title: string;
  content: string;
  tags: string[];
  importance: number;
  pinned: boolean;
  status: Status;
  supersedes: string | null;
  source_agent: string | null;
  session_id: string | null;
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
  expires_at: string | null;
  /** Stable topic identifier; writes with the same key revise in place. */
  topic_key: string | null;
  /** 1 on create, +1 per topic revision. */
  revision_count: number;
  /** Scheduled re-review date; overdue memories are flagged, never hidden. */
  review_after: string | null;
  /** Device tag: applies only on that device (null = all devices). */
  device: string | null;
  /** Agent tag: applies only in that agent tool (null = all agents). */
  agent: string | null;
  /** Derived scope layer: user | project | device | agent. */
  scope: Scope;
  /**
   * Monotonic CAS token, 1 on create and +1 per mutation (any action). A caller
   * that read version N may pass expected_version to reject a stale write.
   */
  version: number;
  /** Provenance locators for this conclusion. */
  evidence: Evidence[];
}

export interface SearchHit extends Memory {
  score: number;
  /** Pure lexical-text component (0..1) exposed for hybrid blending. */
  textScore: number;
  /** Cosine similarity when semantic search contributed, else null. */
  semanticScore: number | null;
  /** True when review_after has passed (advisory, never hides content). */
  needsReview: boolean;
  snippet: string;
}

type Row = Record<string, unknown>;

const parseTags = (raw: unknown): string[] => {
  try {
    const value = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
};

/** Lenient evidence parse for stored rows: bad legacy values never break a read. */
const parseEvidence = (raw: unknown): Evidence[] => {
  try {
    const value = JSON.parse(String(raw ?? '[]'));
    if (!Array.isArray(value)) return [];
    return value
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => ({
        kind: String(item.kind ?? 'note') as EvidenceKind,
        locator: String(item.locator ?? ''),
        quote: item.quote === undefined || item.quote === null ? null : String(item.quote),
        at: item.at === undefined || item.at === null ? null : String(item.at),
      }))
      .filter((e) => e.locator.length > 0);
  } catch {
    return [];
  }
};

/**
 * Strict evidence normalization for write paths: an unknown kind is a loud
 * error (a typo must not silently degrade provenance to free text), duplicates
 * collapse, and the list is capped — evidence is provenance, not a transcript.
 */
export function normalizeEvidence(raw: unknown, at: string = nowIso()): Evidence[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new HiveMemError('INVALID_EVIDENCE', 'evidence 必须是数组：{kind, locator, quote?}[]');
  }
  const out: Evidence[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      throw new HiveMemError('INVALID_EVIDENCE', 'evidence 每一项必须是 {kind, locator, quote?} 对象');
    }
    const rec = item as Record<string, unknown>;
    const kind = String(rec.kind ?? '').trim().toLowerCase();
    if (!EVIDENCE_KINDS.includes(kind as EvidenceKind)) {
      throw new HiveMemError('INVALID_EVIDENCE', `evidence.kind 必须是 ${EVIDENCE_KINDS.join(' | ')} 之一`, {
        detail: { received: kind },
      });
    }
    const locator = clip(String(rec.locator ?? '').trim(), MAX_EVIDENCE_TEXT);
    if (!locator) {
      throw new HiveMemError('INVALID_EVIDENCE', 'evidence.locator 不能为空（会话 id / 文件:行 / URL / 命令）');
    }
    const key = `${kind}\u0000${locator}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const quote = rec.quote === undefined || rec.quote === null ? '' : clip(String(rec.quote).trim(), MAX_EVIDENCE_QUOTE);
    const stamp = rec.at === undefined || rec.at === null ? at : String(rec.at);
    out.push({ kind: kind as EvidenceKind, locator, quote: quote || null, at: stamp });
  }
  return out.slice(0, MAX_EVIDENCE);
}

/** Append new evidence to an existing list, keeping first occurrence, capped. */
function mergeEvidence(base: Evidence[], extra: Evidence[]): Evidence[] {
  const seen = new Set(base.map((e) => `${e.kind}\u0000${e.locator}`));
  const merged = [...base];
  for (const item of extra) {
    const key = `${item.kind}\u0000${item.locator}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged.slice(0, MAX_EVIDENCE);
}

const toMemory = (r: Row, userIds?: Set<string>): Memory => ({
  id: String(r.id),
  project_id: String(r.project_id),
  kind: r.kind as Kind,
  title: String(r.title),
  content: String(r.content),
  tags: parseTags(r.tags),
  importance: Number(r.importance),
  pinned: !!r.pinned,
  status: r.status as Status,
  supersedes: (r.supersedes as string | null) ?? null,
  source_agent: (r.source_agent as string | null) ?? null,
  session_id: (r.session_id as string | null) ?? null,
  created_at: String(r.created_at),
  updated_at: String(r.updated_at),
  last_accessed_at: (r.last_accessed_at as string | null) ?? null,
  expires_at: (r.expires_at as string | null) ?? null,
  topic_key: (r.topic_key as string | null) ?? null,
  revision_count: Number(r.revision_count ?? 1),
  review_after: (r.review_after as string | null) ?? null,
  device: (r.device as string | null) ?? null,
  agent: (r.agent as string | null) ?? null,
  scope: scopeOf(
    {
      project_id: String(r.project_id),
      device: (r.device as string | null) ?? null,
      agent: (r.agent as string | null) ?? null,
    },
    userIds,
  ),
  version: Number(r.version ?? 1),
  evidence: parseEvidence(r.evidence),
});

const isOverdue = (m: Memory): boolean =>
  m.review_after !== null && Number.isFinite(Date.parse(m.review_after)) && Date.parse(m.review_after) <= Date.now();

const withHitFields = (m: Memory, score: number, textScore: number): SearchHit => ({
  ...m,
  score: Math.round(score * 1000) / 1000,
  textScore: Math.round(textScore * 1000) / 1000,
  semanticScore: null,
  needsReview: isOverdue(m),
  snippet: clip(m.content.replace(/\s+/g, ' '), 160),
});

function audit(
  db: Db,
  projectId: string,
  memoryId: string | null,
  action: string,
  actor: string | null,
  detail: unknown,
): void {
  db.prepare(
    'INSERT INTO audit_log (ts, project_id, memory_id, action, actor, detail) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(nowIso(), projectId, memoryId, action, actor ?? null, JSON.stringify(detail ?? {}));
}

/** Audit agent-driven reads (memory_read / memory_bootstrap) so cross-project access is visible. */
export function recordAccess(
  db: Db,
  projectId: string,
  memoryId: string | null,
  action: 'read' | 'bootstrap',
  actor: string | null,
  detail: unknown,
): void {
  audit(db, projectId, memoryId, action, actor, detail);
}

/**
 * Full-row snapshot used by `memory_revisions`. Explicit field pick (not a
 * spread) so the stored shape stays stable as Memory grows: a historical
 * snapshot must remain readable by a later version of the code.
 */
function snapshotOf(m: Memory): string {
  return JSON.stringify({
    id: m.id,
    project_id: m.project_id,
    kind: m.kind,
    title: m.title,
    content: m.content,
    tags: m.tags,
    importance: m.importance,
    pinned: m.pinned,
    status: m.status,
    supersedes: m.supersedes,
    source_agent: m.source_agent,
    session_id: m.session_id,
    created_at: m.created_at,
    updated_at: m.updated_at,
    expires_at: m.expires_at,
    topic_key: m.topic_key,
    revision_count: m.revision_count,
    review_after: m.review_after,
    last_accessed_at: m.last_accessed_at,
    device: m.device,
    agent: m.agent,
    version: m.version,
    evidence: m.evidence,
  });
}

/**
 * Persist the row as it was BEFORE a mutation, keyed by its own version, so
 * `readMemoryAt(id, prev.version)` returns that exact state later. Revisions
 * carry no foreign key: deleting a memory must not erase the history of what it
 * used to say (same reasoning as audit_log).
 */
function recordRevision(db: Db, prev: Memory, action: string, actor: string | null): void {
  db.prepare(
    `INSERT OR IGNORE INTO memory_revisions (memory_id, project_id, version, action, actor, ts, snapshot)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(prev.id, prev.project_id, prev.version, action, actor ?? null, nowIso(), snapshotOf(prev));
}

/** Reject a stale write: the caller's version must still be the current one. */
function assertVersion(current: Memory, expected: number | undefined | null): void {
  if (expected === undefined || expected === null) return;
  if (!Number.isInteger(expected) || expected < 1) {
    throw new HiveMemError('INVALID_INPUT', `expected_version 必须是正整数（收到 ${String(expected)}）`);
  }
  if (current.version !== expected) {
    throw new HiveMemError(
      'REVISION_CONFLICT',
      `记忆 ${current.id} 已被其他写入者修改：你的版本是 ${expected}，当前版本是 ${current.version}`,
      {
        hint: '先 memory_read 拿到当前版本与内容，基于新内容重做修改；不要用旧内容覆盖并发改动。',
        detail: {
          memory_id: current.id,
          expected_version: expected,
          current_version: current.version,
          current_title: current.title,
        },
      },
    );
  }
}

export interface WriteInput {
  projectId: string;
  title: string;
  content: string;
  kind: Kind;
  tags?: string[];
  importance?: number;
  pinned?: boolean;
  /** Memory id this entry supersedes; that memory is auto-marked superseded. */
  supersedes?: string | null;
  /**
   * Stable topic key (e.g. "architecture/auth-model"). A write whose key
   * already exists in this project REVISES that memory in place
   * (revision_count + 1) instead of creating a duplicate.
   */
  topicKey?: string | null;
  sourceAgent?: string | null;
  sessionId?: string | null;
  /** Explicit expiry (ISO-8601). Takes precedence over ttlDays. */
  expiresAt?: string | null;
  /** Days from now until expiry; omit for no expiry. */
  ttlDays?: number;
  /** Explicit review date; defaults by kind when omitted. */
  reviewAfter?: string | null;
  /** Device tag for device/agent-scoped writes (null = project scope). */
  device?: string | null;
  /** Agent tag for agent-scoped writes (device is normally set too). */
  agent?: string | null;
  /** Override creation timestamp (used by imports to preserve real recency). */
  createdAt?: string;
  updatedAt?: string;
  /** Provenance locators: where this conclusion came from. */
  evidence?: Evidence[];
  /**
   * Optimistic concurrency for the topic upsert path: when the caller read the
   * topic at version N, a revision based on a stale N is rejected instead of
   * silently overwriting the concurrent revision.
   */
  expectedVersion?: number;
}

/** Default review intervals (days) for durable kinds; others get none. */
export const REVIEW_DAYS: Partial<Record<Kind, number>> = {
  preference: 90,
  fact: 180,
  decision: 180,
  procedure: 365,
};

const defaultReviewAfter = (kind: Kind, fromIso: string): string | null => {
  const days = REVIEW_DAYS[kind];
  return days ? new Date(Date.parse(fromIso) + days * 86_400_000).toISOString() : null;
};

export function writeMemory(db: Db, input: WriteInput): Memory {
  if (!KINDS.includes(input.kind)) {
    throw new HiveMemError('INVALID_KIND', `kind 必须是 ${KINDS.join(' | ')} 之一`);
  }
  if (!input.title.trim() || !input.content.trim()) {
    throw new HiveMemError('INVALID_INPUT', 'title 和 content 不能为空');
  }
  const topicKey = input.topicKey?.trim() || null;

  // Topic upsert: an existing active memory with the same key — in the SAME
  // scope (device/agent tags must match, NULL-safe) — is revised in place.
  if (topicKey) {
    const row = db
      .prepare(
        `SELECT * FROM memories WHERE project_id = ? AND topic_key = ? AND status = 'active'
            AND device IS ? AND agent IS ?
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(input.projectId, topicKey, input.device ?? null, input.agent ?? null) as Row | undefined;
    if (row) {
      const existing = toMemory(row);
      assertVersion(existing, input.expectedVersion);
      const now = nowIso();
      const expiresAt =
        input.expiresAt !== undefined
          ? input.expiresAt
          : input.ttlDays && input.ttlDays > 0
            ? new Date(Date.now() + input.ttlDays * 86_400_000).toISOString()
            : existing.expires_at;
      // A revised topic ACCUMULATES evidence: each revision adds its sources to
      // the ones that produced the earlier text (that is what makes the final
      // statement auditable), instead of dropping the lineage on every rewrite.
      const evidence = mergeEvidence(existing.evidence, normalizeEvidence(input.evidence, now));
      recordRevision(db, existing, 'revise', input.sourceAgent ?? null);
      db.prepare(
        `UPDATE memories SET title = ?, content = ?, kind = ?, tags = ?, importance = ?, pinned = ?,
            expires_at = ?, revision_count = revision_count + 1, version = version + 1,
            evidence = ?, updated_at = ?, device = ?, agent = ?
          WHERE id = ?`,
      ).run(
        input.title.trim(),
        input.content,
        input.kind,
        JSON.stringify(input.tags ?? existing.tags),
        clamp01(input.importance ?? existing.importance),
        input.pinned !== undefined ? (input.pinned ? 1 : 0) : existing.pinned ? 1 : 0,
        expiresAt,
        JSON.stringify(evidence),
        now,
        input.device ?? null,
        input.agent ?? null,
        existing.id,
      );
      audit(db, input.projectId, existing.id, 'revise', input.sourceAgent ?? null, {
        topic_key: topicKey,
        previous: { title: existing.title, content: existing.content, revision: existing.revision_count },
      });
      const revised = getMemory(db, existing.id);
      if (!revised) throw new HiveMemError('DB_ERROR', '修订后读取失败');
      return revised;
    }
  }

  let superseded: Memory | null = null;
  if (input.supersedes) {
    superseded = getMemory(db, input.supersedes);
    if (!superseded || superseded.project_id !== input.projectId) {
      throw new HiveMemError('SUPERSEDE_TARGET_NOT_FOUND', `被取代的记忆 ${input.supersedes} 不存在（或不在当前项目）`);
    }
  }
  const id = newMemoryId();
  const createdAt = input.createdAt ?? nowIso();
  const updatedAt = input.updatedAt ?? createdAt;
  const expiresAt =
    input.expiresAt !== undefined
      ? input.expiresAt
      : input.ttlDays && input.ttlDays > 0
        ? new Date(Date.parse(updatedAt) + input.ttlDays * 86_400_000).toISOString()
        : null;
  const importance = clamp01(input.importance ?? 0.5);
  const reviewAfter = input.reviewAfter !== undefined ? input.reviewAfter : defaultReviewAfter(input.kind, updatedAt);
  db.prepare(
    `INSERT INTO memories
       (id, project_id, kind, title, content, tags, importance, pinned, status, supersedes, source_agent, session_id, created_at, updated_at, expires_at, topic_key, revision_count, version, evidence, review_after, device, agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?)`,
  ).run(
    id,
    input.projectId,
    input.kind,
    input.title.trim(),
    input.content,
    JSON.stringify(input.tags ?? []),
    importance,
    input.pinned ? 1 : 0,
    input.supersedes ?? null,
    input.sourceAgent ?? null,
    input.sessionId ?? null,
    createdAt,
    updatedAt,
    expiresAt,
    topicKey,
    JSON.stringify(normalizeEvidence(input.evidence, createdAt)),
    reviewAfter,
    input.device ?? null,
    input.agent ?? null,
  );
  audit(db, input.projectId, id, 'create', input.sourceAgent ?? null, {
    title: input.title.trim(),
    kind: input.kind,
    importance,
    ...(topicKey ? { topic_key: topicKey } : {}),
    ...(input.device ? { device: input.device } : {}),
    ...(input.agent ? { agent: input.agent } : {}),
  });
  if (superseded) {
    db.prepare("UPDATE memories SET status = 'superseded', updated_at = ? WHERE id = ?").run(
      nowIso(),
      superseded.id,
    );
    audit(db, input.projectId, superseded.id, 'supersede', input.sourceAgent ?? null, {
      by: id,
      title: superseded.title,
    });
  }
  const created = getMemory(db, id);
  if (!created) throw new HiveMemError('DB_ERROR', '写入后读取失败');
  return created;
}

export function getMemory(db: Db, id: string, options?: { touch?: boolean }): Memory | null {
  const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Row | undefined;
  if (!row) return null;
  const userIds = userProjectIds(db);
  if (options?.touch) {
    db.prepare('UPDATE memories SET last_accessed_at = ? WHERE id = ?').run(nowIso(), id);
    const fresh = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Row | undefined;
    return fresh ? toMemory(fresh, userIds) : toMemory(row, userIds);
  }
  return toMemory(row, userIds);
}

export function requireMemory(db: Db, projectId: string, id: string): Memory {
  const m = getMemory(db, id);
  if (!m || m.project_id !== projectId) {
    throw new HiveMemError('MEMORY_NOT_FOUND', `记忆 ${id} 不存在（或不在当前项目）`);
  }
  return m;
}

/**
 * Resolve a memory addressed from a project view (`memory_read` /
 * `memory_update` / `memory_archive`).
 *
 * Project, device and agent memories stay strictly inside `projectId` — that
 * is what keeps projects isolated. User-level memories are the one exception:
 * they physically live in the caller's reserved `@user` project while riding
 * along with every project's brief and search results, so a workspace request
 * must be able to address them by id. The fallback accepts `userProjectId`
 * only (the caller's own row), never another user's `@user` project, so
 * cross-user isolation is unchanged.
 */
export function requireMemoryForProject(
  db: Db,
  projectId: string,
  id: string,
  userProjectId?: string | null,
): Memory {
  const m = getMemory(db, id);
  if (m && (m.project_id === projectId || (userProjectId != null && m.project_id === userProjectId))) {
    return m;
  }
  throw new HiveMemError('MEMORY_NOT_FOUND', `记忆 ${id} 不存在（或不在当前项目）`);
}

/** Rebuild a Memory from a stored revision snapshot (defensive: history must never throw). */
function fromSnapshot(snap: Record<string, unknown>, userIds?: Set<string>): Memory {
  const projectId = String(snap.project_id ?? '');
  const device = snap.device === undefined || snap.device === null ? null : String(snap.device);
  const agent = snap.agent === undefined || snap.agent === null ? null : String(snap.agent);
  return {
    id: String(snap.id ?? ''),
    project_id: projectId,
    kind: String(snap.kind ?? 'fact') as Kind,
    title: String(snap.title ?? ''),
    content: String(snap.content ?? ''),
    tags: Array.isArray(snap.tags) ? (snap.tags as unknown[]).map(String) : [],
    importance: Number(snap.importance ?? 0.5),
    pinned: Boolean(snap.pinned),
    status: String(snap.status ?? 'active') as Status,
    supersedes: snap.supersedes === undefined || snap.supersedes === null ? null : String(snap.supersedes),
    source_agent: snap.source_agent === undefined || snap.source_agent === null ? null : String(snap.source_agent),
    session_id: snap.session_id === undefined || snap.session_id === null ? null : String(snap.session_id),
    created_at: String(snap.created_at ?? ''),
    updated_at: String(snap.updated_at ?? ''),
    expires_at: snap.expires_at === undefined || snap.expires_at === null ? null : String(snap.expires_at),
    topic_key: snap.topic_key === undefined || snap.topic_key === null ? null : String(snap.topic_key),
    revision_count: Number(snap.revision_count ?? 1),
    review_after: snap.review_after === undefined || snap.review_after === null ? null : String(snap.review_after),
    last_accessed_at:
      snap.last_accessed_at === undefined || snap.last_accessed_at === null ? null : String(snap.last_accessed_at),
    device,
    agent,
    scope: scopeOf({ project_id: projectId, device, agent }, userIds),
    version: Number(snap.version ?? 1),
    evidence: parseEvidence(JSON.stringify(snap.evidence ?? [])),
  };
}

/**
 * Read a memory as it stood at a given version. Version N is the state *before*
 * mutation N+1 happened, so the current state is served from the live row and
 * older states from `memory_revisions`. Returns null when that version was never
 * recorded (e.g. it predates schema v6).
 */
export function readMemoryAt(db: Db, id: string, version: number): Memory | null {
  if (!Number.isInteger(version) || version < 1) {
    throw new HiveMemError('INVALID_INPUT', `at_version 必须是正整数（收到 ${String(version)}）`);
  }
  const live = getMemory(db, id);
  if (live && live.version === version) return live;
  const row = db
    .prepare('SELECT snapshot FROM memory_revisions WHERE memory_id = ? AND version = ?')
    .get(id, version) as { snapshot: string } | undefined;
  if (!row) return null;
  try {
    return fromSnapshot(JSON.parse(String(row.snapshot)) as Record<string, unknown>, userProjectIds(db));
  } catch {
    return null;
  }
}

export interface RevisionEntry {
  version: number;
  action: string;
  actor: string | null;
  ts: string;
  /** Title at that version, for a scannable history list. */
  title: string | null;
}

/**
 * Version history of one memory, newest first. A revision row is written when a
 * mutation replaces the state that version described, so the list holds only
 * SUPERSEDED versions — the live body is `getMemory` / `readMemoryAt(current)`.
 * Every older body stays addressable instead of being buried inside an
 * audit_log JSON blob.
 */
export function listRevisions(db: Db, memoryId: string, limit = 50): RevisionEntry[] {
  const rows = db
    .prepare(
      `SELECT version, action, actor, ts, snapshot FROM memory_revisions
        WHERE memory_id = ? ORDER BY version DESC LIMIT ?`,
    )
    .all(memoryId, Math.max(1, Math.min(200, Math.trunc(limit)))) as Row[];
  return rows.map((r) => {
    let title: string | null = null;
    try {
      const snap = JSON.parse(String(r.snapshot)) as Record<string, unknown>;
      title = snap.title === undefined || snap.title === null ? null : String(snap.title);
    } catch {
      title = null;
    }
    return {
      version: Number(r.version),
      action: String(r.action),
      actor: r.actor === undefined || r.actor === null ? null : String(r.actor),
      ts: String(r.ts),
      title,
    };
  });
}

export interface UpdatePatch {
  title?: string;
  content?: string;
  kind?: Kind;
  tags?: string[];
  importance?: number;
  pinned?: boolean;
  status?: Status;
  supersedes?: string | null;
  topic_key?: string | null;
  /** Scope migration: set/clear the device tag (undefined = keep). */
  device?: string | null;
  /** Scope migration: set/clear the agent tag (undefined = keep). */
  agent?: string | null;
  /**
   * Evidence list replacement (undefined = keep). Unlike the topic-upsert
   * write path — which appends, because the caller has not seen the old list —
   * an update is an explicit PATCH over a row the caller is looking at, so
   * replacement is what lets a wrong locator be removed.
   */
  evidence?: Evidence[];
  /**
   * Optimistic concurrency token: pass the `version` you read. A stale value
   * is rejected with REVISION_CONFLICT instead of overwriting someone's edit.
   */
  expectedVersion?: number;
}

export function updateMemory(
  db: Db,
  projectId: string,
  id: string,
  patch: UpdatePatch,
  actor?: string | null,
): Memory {
  const prev = requireMemory(db, projectId, id);
  assertVersion(prev, patch.expectedVersion);
  if (patch.kind !== undefined && !KINDS.includes(patch.kind)) {
    throw new HiveMemError('INVALID_KIND', `kind 必须是 ${KINDS.join(' | ')} 之一`);
  }
  if (patch.status !== undefined && !STATUSES.includes(patch.status)) {
    throw new HiveMemError('INVALID_STATUS', `status 必须是 ${STATUSES.join(' | ')} 之一`);
  }
  const next = {
    title: (patch.title ?? prev.title).trim(),
    content: patch.content ?? prev.content,
    kind: patch.kind ?? prev.kind,
    tags: patch.tags ?? prev.tags,
    importance: patch.importance !== undefined ? clamp01(patch.importance) : prev.importance,
    pinned: patch.pinned !== undefined ? patch.pinned : prev.pinned,
    status: patch.status ?? prev.status,
    supersedes: patch.supersedes !== undefined ? patch.supersedes : prev.supersedes,
    topicKey: patch.topic_key !== undefined ? (patch.topic_key?.trim() || null) : prev.topic_key,
    device: patch.device !== undefined ? patch.device : prev.device,
    agent: patch.agent !== undefined ? patch.agent : prev.agent,
    evidence: patch.evidence !== undefined ? normalizeEvidence(patch.evidence) : prev.evidence,
  };
  if (!next.title || !next.content.trim()) {
    throw new HiveMemError('INVALID_INPUT', 'title 和 content 不能为空');
  }
  recordRevision(db, prev, next.status === prev.status ? 'update' : next.status, actor ?? null);
  db.prepare(
    `UPDATE memories
       SET title = ?, content = ?, kind = ?, tags = ?, importance = ?, pinned = ?, status = ?, supersedes = ?, topic_key = ?, device = ?, agent = ?,
           evidence = ?, version = version + 1, updated_at = ?
     WHERE id = ? AND project_id = ?`,
  ).run(
    next.title,
    next.content,
    next.kind,
    JSON.stringify(next.tags),
    next.importance,
    next.pinned ? 1 : 0,
    next.status,
    next.supersedes ?? null,
    next.topicKey,
    next.device,
    next.agent,
    JSON.stringify(next.evidence),
    nowIso(),
    id,
    projectId,
  );
  audit(db, projectId, id, 'update', actor ?? null, {
    previous: {
      title: prev.title,
      content: prev.content,
      kind: prev.kind,
      tags: prev.tags,
      importance: prev.importance,
      pinned: prev.pinned,
      status: prev.status,
      device: prev.device,
      agent: prev.agent,
      version: prev.version,
    },
  });
  const updated = getMemory(db, id);
  if (!updated) throw new HiveMemError('DB_ERROR', '更新后读取失败');
  return updated;
}

export function archiveMemory(
  db: Db,
  projectId: string,
  id: string,
  actor?: string | null,
  opts?: { expectedVersion?: number },
): Memory {
  return updateMemory(db, projectId, id, { status: 'archived', expectedVersion: opts?.expectedVersion }, actor);
}

/** Move a memory to another project (audited; used by the web platform). */
export function moveMemory(db: Db, id: string, toProjectId: string, actor?: string | null): Memory {
  const existing = getMemory(db, id);
  if (!existing) throw new HiveMemError('MEMORY_NOT_FOUND', `记忆 ${id} 不存在`);
  if (existing.project_id === toProjectId) return existing;
  recordRevision(db, existing, 'move', actor ?? null);
  db.prepare('UPDATE memories SET project_id = ?, version = version + 1, updated_at = ? WHERE id = ?').run(
    toProjectId,
    nowIso(),
    id,
  );
  audit(db, toProjectId, id, 'move', actor ?? null, {
    from_project: existing.project_id,
    title: existing.title,
  });
  const moved = getMemory(db, id);
  if (!moved) throw new HiveMemError('DB_ERROR', '移动后读取失败');
  return moved;
}

export function deleteMemory(db: Db, projectId: string, id: string, actor?: string | null): void {
  const prev = requireMemory(db, projectId, id);
  // Keep the deleted row in the revision history: deletion removes the memory,
  // not the record of what it said (revisions carry no FK by design).
  recordRevision(db, prev, 'delete', actor ?? null);
  db.prepare('DELETE FROM memories WHERE id = ? AND project_id = ?').run(id, projectId);
  audit(db, projectId, id, 'delete', actor ?? null, { title: prev.title, kind: prev.kind });
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

const KIND_WEIGHT: Record<Kind, number> = {
  decision: 1,
  fact: 0.8,
  preference: 0.8,
  procedure: 0.7,
  snippet: 0.5,
  episodic: 0.4,
};

/** Blend text rank with recency, importance, pin state and kind weight. */
function blendScore(m: Memory, textPosition: number | null): number {
  const text = textPosition === null ? 0 : 1 / (textPosition + 1);
  const ageDays = Math.max(0, (Date.now() - Date.parse(m.updated_at)) / 86_400_000);
  const recency = Number.isFinite(ageDays) ? Math.exp(-ageDays / 30) : 0;
  return (
    0.45 * text +
    0.2 * recency +
    0.15 * m.importance +
    0.1 * (m.pinned ? 1 : 0) +
    0.1 * (KIND_WEIGHT[m.kind] ?? 0.5)
  );
}

const escapeLike = (s: string): string =>
  s.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');

export interface SearchOptions {
  projectId?: string;
  /** Search across several projects (e.g. a project + '@user'); supersedes projectId. */
  projectIds?: string[];
  /** Restrict hits to one scope layer; default: all scopes, annotated. */
  scope?: Scope;
  query?: string;
  kind?: Kind;
  status?: Status;
  tags?: string[];
  /**
   * Exact device-tag filter (web tree navigation). undefined = no filter;
   * null or '' = device IS NULL (project-scope rows); a name = device = name.
   */
  device?: string | null;
  /** Exact agent-tag filter; same undefined/null/''/name semantics as device. */
  agent?: string | null;
  limit?: number;
  offset?: number;
}

export interface SearchResult {
  hits: SearchHit[];
  total: number;
  mode: 'browse' | 'fts' | 'substring' | 'hybrid';
  /** Explicit degradation notices (never silently degrade). */
  warnings?: string[];
}

/** TTL filter: expired-but-active memories are invisible until swept to archived. */
const NOT_EXPIRED = "(m.expires_at IS NULL OR julianday(m.expires_at) > julianday('now'))";

export function searchMemories(db: Db, options: SearchOptions): SearchResult {
  const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
  const offset = Math.max(0, options.offset ?? 0);

  // An explicitly empty project set means "nothing accessible" (e.g. a
  // non-admin global search with no owned or granted projects) — never fall
  // through to an unfiltered scan.
  if (options.projectIds && options.projectIds.length === 0) {
    return { hits: [], total: 0, mode: 'browse' };
  }

  const conds: string[] = [];
  // TTL only hides expired-but-active memories; archived/superseded views show them.
  if (options.status === undefined || options.status === 'active') conds.push(NOT_EXPIRED);
  const params: (string | number | null)[] = [];
  const projectIds = options.projectIds ?? (options.projectId ? [options.projectId] : []);
  if (projectIds.length > 0) {
    conds.push(`m.project_id IN (${projectIds.map(() => '?').join(',')})`);
    params.push(...projectIds);
  }
  if (options.scope) conds.push(scopeCondition(options.scope));
  if (options.device !== undefined) {
    if (options.device === null || options.device === '') conds.push('m.device IS NULL');
    else {
      conds.push('m.device = ?');
      params.push(options.device);
    }
  }
  if (options.agent !== undefined) {
    if (options.agent === null || options.agent === '') conds.push('m.agent IS NULL');
    else {
      conds.push('m.agent = ?');
      params.push(options.agent);
    }
  }
  if (options.status) {
    conds.push('m.status = ?');
    params.push(options.status);
  }
  if (options.kind) {
    conds.push('m.kind = ?');
    params.push(options.kind);
  }
  for (const tag of options.tags ?? []) {
    conds.push("m.tags LIKE ? ESCAPE '\\'");
    params.push(`%"${escapeLike(tag)}"%`);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const andConds = conds.map((c) => `AND ${c}`).join(' ');

  const q = options.query?.trim() ?? '';

  // Browse: no query text, newest and pinned first.
  if (!q) {
    const userIds = userProjectIds(db);
    const rows = db
      .prepare(
        `SELECT m.* FROM memories m ${where} ORDER BY m.pinned DESC, m.updated_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Row[];
    return {
      hits: rows.map((r) => {
        const m = toMemory(r, userIds);
        return withHitFields(m, blendScore(m, null), 0);
      }),
      total: rows.length,
      mode: 'browse',
    };
  }

  // FTS5 trigram: queries of 3+ code points.
  if (runeLength(q) >= 3) {
    const match = `"${q.replaceAll('"', '""')}"`;
    const rows = db
      .prepare(
        `SELECT m.* FROM memories m
           JOIN memories_fts ON memories_fts.rowid = m.rowid
         WHERE memories_fts MATCH ? ${andConds}
         ORDER BY bm25(memories_fts)
         LIMIT 200`,
      )
      .all(match, ...params) as Row[];
    const userIds = userProjectIds(db);
    const scored = rows
      .map((r, i) => {
        const m = toMemory(r, userIds);
        const text = 1 / (i + 1);
        return { m, s: blendScore(m, i), text };
      })
      .sort((a, b) => b.s - a.s);
    return {
      hits: scored.slice(offset, offset + limit).map(({ m, s, text }) => withHitFields(m, s, text)),
      total: scored.length,
      mode: 'fts',
    };
  }

  // Short queries (e.g. 2-char Chinese words): substring fallback.
  const like = `%${escapeLike(q.toLowerCase())}%`;
  const lower = q.toLowerCase();
  const rows = db
    .prepare(
      `SELECT m.* FROM memories m
         WHERE (lower(m.title) LIKE ? ESCAPE '\\' OR lower(m.content) LIKE ? ESCAPE '\\' OR lower(m.tags) LIKE ? ESCAPE '\\')
         ${andConds}
         LIMIT 200`,
    )
    .all(like, like, like, ...params) as Row[];
  const userIds = userProjectIds(db);
  const scored = rows
    .map((r) => {
      const m = toMemory(r, userIds);
      const pos = m.title.toLowerCase().includes(lower) ? 0 : 3;
      const text = 1 / (pos + 1);
      return { m, s: blendScore(m, pos), text };
    })
    .sort((a, b) => b.s - a.s);
  return {
    hits: scored.slice(offset, offset + limit).map(({ m, s, text }) => withHitFields(m, s, text)),
    total: scored.length,
    mode: 'substring',
  };
}

// ---------------------------------------------------------------------------
// Bootstrap brief
// ---------------------------------------------------------------------------

/** Rows that are still live: no expiry, or expiry in the future. */
const ALIVE_SQL = "(expires_at IS NULL OR julianday(expires_at) > julianday('now'))";

/**
 * Character budget bounds for one brief. The default matches what the tooling
 * passes when it has no opinion; the range keeps a typo (`budget=12`) from
 * rendering a useless two-line brief and keeps a runaway budget from turning a
 * session-start hint into a transcript.
 */
export const BRIEF_BUDGET_DEFAULT = 2600;
export const BRIEF_BUDGET_MIN = 512;
export const BRIEF_BUDGET_MAX = 8000;

/**
 * Why `total - shown` memories are absent, split by cause. The two are
 * actionable in different ways: a budget drop says "ask for a bigger read or
 * page the index", a priority drop says "this project holds more than a brief
 * can carry — search it". Merging them into one number tells the reader
 * neither.
 */
export interface BootstrapOmissions {
  /** A section selected it, but the character budget could not fit the line. */
  budget: number;
  /** It never reached a section: the section's own LIMIT filled first. */
  priority: number;
}

export interface BootstrapBrief {
  rendered: string;
  /** True when the brief does not cover every active memory of the project. */
  truncated: boolean;
  sources: string[];
  budget: number;
  /** Active memories in the project (project + device + agent layers). */
  total: number;
  /** Project-layer entries actually listed here (user-level rows excluded). */
  shown: number;
  /** The `total - shown` gap, split into budget vs priority drops. */
  omitted: BootstrapOmissions;
  /**
   * User-level rows (the cross-project `@user` layer). Counted separately
   * because they belong to another project: they are never part of `total`,
   * yet dropping them silently would make a complete-looking brief incomplete.
   */
  userLevel: { total: number; shown: number };
}

/**
 * Curated session-start brief, layered by scope (DESIGN.md §13): user-level
 * first (identity/preferences color every project), then the project body
 * (pinned / decisions / valuable / recent catch-all), then title-only
 * indexes for this device and this agent tool. Empty layers are skipped and
 * each layer's budget is reserved so later layers cannot be starved.
 *
 * The brief is curated, never complete: when it lists fewer memories than the
 * project holds, it says so in a footer (total / shown / where the full index
 * lives) so an agent cannot mistake a thinned brief for an empty project.
 */
export function bootstrapBrief(
  db: Db,
  projectId: string,
  budget = BRIEF_BUDGET_DEFAULT,
  taskHint?: string,
  ctx?: ScopeContext | null,
  ownerId?: string | null,
): BootstrapBrief {
  // Multi-user mode: every user reads their own '@user' row.
  const userProjectId = ownerId ? ensureUserProject(db, ownerId).id : USER_PROJECT_ID;
  const sources: string[] = [];
  // Two id sets, because two questions are answered over different populations:
  // `renderedIds` (what the reader can see) and `candidateIds` (what a section
  // picked, before the budget had a say). Their difference is the budget drop,
  // and `total - renderedIds.size` is the whole gap.
  const renderedIds = new Set<string>();
  const candidateIds = new Set<string>();
  let projectShown = 0;

  /** One curated line: version token, title, and a per-entry truncation marker. */
  const curatedLine = (m: Memory, max = 180): string => {
    const body = m.content.replace(/\s+/g, ' ').trim();
    const clipped = clip(body, max);
    return `- [${m.id}] v${m.version} ${m.title}：${clipped}${clipped === body ? '' : '（已截断）'}\n`;
  };
  /** Title-only index line for the device / agent / recently-updated sections. */
  const indexLine = (row: Row): string =>
    `- [${row.id}] v${Number(row.version ?? 1)} ${String(row.title)}（${row.kind}，${String(row.updated_at).slice(0, 10)} 更新）`;

  // User-level section: rides along with EVERY project brief, so it gets a
  // tight sub-budget and loads first. Skipped when bootstrapping '@user'
  // itself — the project body below already covers it.
  const userBudget = Math.min(500, Math.floor(budget * 0.2));
  let userText = '';
  // User-level rows live in another project, so they never show up in the
  // project footer; track their omission separately to keep `truncated` honest.
  let userTotal = 0;
  let userShown = 0;
  let userCut = false;
  if (projectId !== userProjectId) {
    const userRows = db
      .prepare(
        `SELECT * FROM memories WHERE project_id = ? AND status = 'active' AND ${ALIVE_SQL}
         ORDER BY pinned DESC, importance DESC, updated_at DESC LIMIT 6`,
      )
      .all(userProjectId) as Row[];
    userTotal = Number(
      (db
        .prepare(`SELECT COUNT(*) AS n FROM memories WHERE project_id = ? AND status = 'active' AND ${ALIVE_SQL}`)
        .get(userProjectId) as { n: number }).n,
    );
    if (userRows.length > 0) {
      const header = '## 用户级记忆（跨项目）\n';
      if (header.length <= userBudget) {
        userText = header;
        for (const row of userRows) {
          const m = toMemory(row);
          const line = curatedLine(m, 120);
          if (userText.length + line.length > userBudget) break;
          userText += line;
          sources.push(m.id);
          userShown++;
        }
        userText += '\n';
      }
    }
    userCut = userShown < userTotal;
  }

  // Device / agent sections: title-only index lines. Their small budget is
  // reserved up front so the project body cannot starve them.
  const titleIndex = (cond: string, params: (string | null)[]): { text: string; ids: string[] } => {
    const rows = db
      .prepare(
        `SELECT id, kind, title, updated_at, version FROM memories
          WHERE project_id = ? AND status = 'active' AND ${ALIVE_SQL} AND ${cond}
          ORDER BY pinned DESC, updated_at DESC LIMIT 8`,
      )
      .all(projectId, ...params) as Row[];
    const ids: string[] = [];
    const lines: string[] = [];
    for (const row of rows) {
      if (renderedIds.has(String(row.id))) continue;
      candidateIds.add(String(row.id));
      ids.push(String(row.id));
      lines.push(indexLine(row));
    }
    return { text: lines.length ? `${lines.join('\n')}\n` : '', ids };
  };
  const devicePart = ctx?.device
    ? titleIndex('device = ? AND agent IS NULL', [ctx.device])
    : { text: '', ids: [] };
  const agentPart =
    ctx?.device && ctx?.agent ? titleIndex('device = ? AND agent = ?', [ctx.device, ctx.agent]) : { text: '', ids: [] };

  // Project body: strictly project-scope rows; device/agent rows have their
  // own contextual sections.
  const projectScope = 'AND device IS NULL AND agent IS NULL';
  const pinned = db
    .prepare(
      `SELECT * FROM memories WHERE project_id = ? AND status = 'active' AND pinned = 1 AND ${ALIVE_SQL} ${projectScope}
       ORDER BY importance DESC, updated_at DESC LIMIT 10`,
    )
    .all(projectId) as Row[];
  const decisions = db
    .prepare(
      `SELECT * FROM memories WHERE project_id = ? AND status = 'active' AND pinned = 0 AND kind = 'decision' AND ${ALIVE_SQL} ${projectScope}
       ORDER BY importance DESC, updated_at DESC LIMIT 15`,
    )
    .all(projectId) as Row[];
  // No importance threshold: agents rarely set it, and a 0.7 floor made
  // default-importance facts invisible (gwm_app rendered an empty brief).
  // Bounded by LIMIT + importance/recency ordering instead. Procedures are
  // session-critical and previously had no section at all.
  const valuable = db
    .prepare(
      `SELECT * FROM memories WHERE project_id = ? AND status = 'active' AND pinned = 0
         AND kind IN ('fact','preference','procedure') AND ${ALIVE_SQL} ${projectScope}
       ORDER BY importance DESC, updated_at DESC LIMIT 10`,
    )
    .all(projectId) as Row[];

  const sections = [
    { title: '置顶记忆', rows: pinned },
    { title: '关键决策', rows: decisions },
    { title: '关键事实 / 偏好 / 流程', rows: valuable },
  ].filter((s) => s.rows.length > 0);

  // Task lens (Memorix-inspired): a task hint adds a hint-matched section
  // first; user-level rows ride along and dedupe against the user block.
  if (taskHint?.trim()) {
    const related = searchMemories(db, {
      projectIds: [projectId, userProjectId],
      query: taskHint.trim(),
      limit: 5,
    });
    const fresh = related.hits.filter((h) => !renderedIds.has(h.id));
    if (fresh.length > 0) {
      sections.unshift({ title: '任务相关记忆', rows: fresh as unknown as Row[] });
    }
  }

  // Everything a section picked is a candidate, whether or not the budget can
  // fit it: that distinction is what the footer reports.
  for (const section of sections) {
    for (const row of section.rows) candidateIds.add(String(row.id));
  }

  // Hard budget invariant: rendered ≤ budget. Each layer's allowance is what
  // remains after the layers before it; a negative allowance just means the
  // layer renders empty and the brief is marked truncated.
  //
  // The completeness footer is reserved up front: it announces the truncation,
  // so it must not itself be the first casualty of that truncation.
  const footerReserve = Math.min(200, Math.floor(budget * 0.1));
  const projectBudget =
    budget - userText.length - devicePart.text.length - agentPart.text.length - footerReserve;
  let projectText = '';
  outer: for (const section of sections) {
    const header = `## ${section.title}\n`;
    if (projectText.length + header.length > projectBudget) break;
    projectText += header;
    for (const row of section.rows) {
      const m = toMemory(row);
      const line = curatedLine(m);
      if (projectText.length + line.length > projectBudget) break outer;
      projectText += line;
      sources.push(m.id);
      renderedIds.add(m.id);
      projectShown++;
    }
  }

  // Recently-updated catch-all (title-only index lines): guarantees the brief
  // tracks memory updates by construction — any kind, newest first, compact
  // enough to survive the budget. Project-scope only; scoped memories surface
  // in their own contextual sections instead.
  const recentRows = db
    .prepare(
      `SELECT id, kind, title, updated_at, version FROM memories
        WHERE project_id = ? AND status = 'active' AND pinned = 0 AND ${ALIVE_SQL} ${projectScope}
       ORDER BY updated_at DESC LIMIT 20`,
    )
    .all(projectId) as Row[];
  const recentLines: string[] = [];
  for (const row of recentRows) {
    if (recentLines.length >= 8) break;
    if (renderedIds.has(String(row.id))) continue;
    candidateIds.add(String(row.id));
    recentLines.push(indexLine(row));
  }
  if (recentLines.length > 0) {
    const block = `\n## 最近更新\n${recentLines.join('\n')}\n`;
    if (projectText.length + block.length <= projectBudget) {
      projectText += block;
      for (const line of recentLines) {
        const id = line.match(/\[(mem_[a-z0-9]+)\]/)?.[1];
        if (!id) continue;
        sources.push(id);
        renderedIds.add(id);
      }
      projectShown += recentLines.length;
    }
  }

  let rendered = userText + projectText;
  if (devicePart.text) {
    const block = `\n## 本设备记忆（${ctx?.device}）\n${devicePart.text}`;
    if (rendered.length + block.length <= budget) {
      rendered += block;
      sources.push(...devicePart.ids);
      for (const id of devicePart.ids) {
        renderedIds.add(id);
      }
      projectShown += devicePart.ids.length;
    }
  }
  if (agentPart.text) {
    const block = `\n## 本工具记忆（${ctx?.agent}）\n${agentPart.text}`;
    if (rendered.length + block.length <= budget) {
      rendered += block;
      sources.push(...agentPart.ids);
      for (const id of agentPart.ids) {
        renderedIds.add(id);
      }
      projectShown += agentPart.ids.length;
    }
  }

  // Completeness footer: a curated brief that silently lists 16 of 85 memories
  // reads like a project with 16 memories. State the real size and point at the
  // full index, so truncation is visible to the agent and to the human reading
  // the same response. Only appended when it fits — a tiny budget simply drops
  // it rather than breaking the hard invariant above.
  const projectTotal = Number(
    (db
      .prepare(`SELECT COUNT(*) AS n FROM memories WHERE project_id = ? AND status = 'active' AND ${ALIVE_SQL}`)
      .get(projectId) as { n: number }).n,
  );
  // Split the gap by cause: a candidate the budget refused, versus a memory no
  // section ever picked. Both are actionable, but not in the same way.
  const shown = renderedIds.size;
  const missing = Math.max(0, projectTotal - shown);
  const budgetDrops = [...candidateIds].filter((id) => !renderedIds.has(id)).length;
  const priorityDrops = Math.max(0, missing - budgetDrops);
  // Authoritative truncation flag: something the reader would want is missing.
  // A skipped section whose rows were all already listed is not truncation.
  const truncated = missing > 0 || userCut;
  // Why the brief is short has two independent causes: the project body, and
  // the cross-project 'user' layer (a different project, so it is invisible to
  // `total`). Both get a footer, because a complete-looking project body with a
  // silently thinned user layer still leaves the reader with the wrong picture.
  const userNote = userCut
    ? `用户级记忆 ${userTotal} 条中列出 ${userShown} 条（全量用 memory_index scope=user）`
    : '';
  if (missing > 0 || userCut) {
    const gaps: string[] = [];
    if (budgetDrops > 0) gaps.push(`预算 ${budgetDrops} 条`);
    if (priorityDrops > 0) gaps.push(`名额 ${priorityDrops} 条`);
    const split = gaps.length ? `${gaps.join(' + ')}` : '原因未分类';
    // Sweep from richest to shortest: the numbers matter more than the pointer,
    // and the pointer matters more than the repository-style URI. Whichever fits
    // wins, so even a tiny budget says *why* the brief is short. The
    // project-only variants stay in the list for budgets that cannot fit both
    // notes — the project gap is the one the reader is most likely to act on.
    const candidates: string[] = [];
    if (missing > 0) {
      const projectNote = `本项目 ${projectTotal} 条 active 中列出 ${shown} 条；未列出 ${missing} 条 = ${split}`;
      candidates.push(
        `\n\n（已截断：${projectNote}${userNote ? `；${userNote}` : ''}；全量索引：memory://projects/${projectId}/index 或 memory_index）`,
        `\n\n（已截断：${projectNote}；全量见 memory_index）`,
      );
    }
    if (userNote) candidates.push(`\n\n（${userNote}）`);
    if (missing > 0) candidates.push(`\n\n（已截断：${projectTotal} 条中列出 ${shown} 条；全量见 memory_index）`);
    for (const footer of candidates) {
      if (rendered.length + footer.length <= budget) {
        rendered += footer;
        break;
      }
    }
  }

  return {
    rendered: rendered.trim(),
    truncated,
    sources,
    budget,
    total: projectTotal,
    shown,
    omitted: { budget: budgetDrops, priority: priorityDrops },
    userLevel: { total: userTotal, shown: userShown },
  };
}

/**
 * Title-level inventory of a project: the enumeration verb the tool surface was
 * missing (bootstrap curates, search needs a query, stats only counts). Reads
 * existing rows — no schema, no extra writes — and always reports `total` so a
 * paged caller can never mistake a page for the whole inventory.
 */
export interface IndexEntry {
  id: string;
  kind: Kind;
  title: string;
  scope: Scope;
  pinned: boolean;
  importance: number;
  device: string | null;
  agent: string | null;
  topic_key: string | null;
  updated_at: string;
}

export interface IndexPage {
  /** Every active memory matching the filter — not just this page. */
  total: number;
  offset: number;
  limit: number;
  /** Offset of the next page, or null when this page is the last one. */
  next_offset: number | null;
  entries: IndexEntry[];
  /** Whole-project distribution, ignoring filters (inventory overview). */
  counts: { by_kind: Record<string, number>; by_scope: Record<string, number> };
}

export interface IndexFilter {
  kind?: Kind;
  /** One layer of this project; omit to list project + device + agent rows. */
  scope?: Exclude<Scope, 'user'>;
  sort?: 'updated' | 'importance' | 'title';
  offset?: number;
  limit?: number;
}

/** Active-memory distribution for a project, split by kind and by scope layer. */
export function indexCounts(
  db: Db,
  projectId: string,
): { total: number; by_kind: Record<string, number>; by_scope: Record<string, number> } {
  const rows = db
    .prepare(
      `SELECT kind,
              CASE WHEN agent IS NOT NULL THEN 'agent'
                   WHEN device IS NOT NULL THEN 'device'
                   ELSE 'project' END AS layer,
              COUNT(*) AS n
         FROM memories
        WHERE project_id = ? AND status = 'active' AND ${ALIVE_SQL}
        GROUP BY kind, layer`,
    )
    .all(projectId) as Array<{ kind: string; layer: string; n: number }>;
  const by_kind: Record<string, number> = {};
  const by_scope: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    const n = Number(row.n);
    by_kind[row.kind] = (by_kind[row.kind] ?? 0) + n;
    by_scope[row.layer] = (by_scope[row.layer] ?? 0) + n;
    total += n;
  }
  return { total, by_kind, by_scope };
}

export function listIndex(db: Db, projectId: string, filter: IndexFilter = {}): IndexPage {
  const limit = Math.min(500, Math.max(1, Math.trunc(filter.limit ?? 50)));
  const offset = Math.max(0, Math.trunc(filter.offset ?? 0));
  const conds = ['project_id = ?', "status = 'active'", ALIVE_SQL];
  const params: Array<string | number> = [projectId];
  if (filter.kind) {
    conds.push('kind = ?');
    params.push(filter.kind);
  }
  // Layer filters mirror scopeCondition(): agent wins over device, and a row
  // with neither tag is project-level.
  if (filter.scope === 'project') conds.push('device IS NULL AND agent IS NULL');
  else if (filter.scope === 'device') conds.push('device IS NOT NULL AND agent IS NULL');
  else if (filter.scope === 'agent') conds.push('agent IS NOT NULL');
  const where = conds.join(' AND ');
  const order =
    filter.sort === 'importance'
      ? 'importance DESC, updated_at DESC, id'
      : filter.sort === 'title'
        ? 'title COLLATE NOCASE ASC, id'
        : 'updated_at DESC, id';

  const total = Number(
    (db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE ${where}`).get(...params) as { n: number }).n,
  );
  const rows = db
    .prepare(`SELECT * FROM memories WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as Row[];
  const userIds = userProjectIds(db);
  const entries: IndexEntry[] = rows.map((r) => {
    const m = toMemory(r, userIds);
    return {
      id: m.id,
      kind: m.kind,
      title: m.title,
      scope: m.scope,
      pinned: m.pinned,
      importance: m.importance,
      device: m.device,
      agent: m.agent,
      topic_key: m.topic_key,
      updated_at: m.updated_at,
    };
  });
  return {
    total,
    offset,
    limit,
    next_offset: offset + entries.length < total ? offset + entries.length : null,
    entries,
    counts: indexCounts(db, projectId),
  };
}

// ---------------------------------------------------------------------------
// Stats & audit
// ---------------------------------------------------------------------------

export function projectStats(db: Db, projectId?: string) {
  const where = projectId ? 'WHERE project_id = ?' : '';
  const args = projectId ? [projectId] : [];
  const byKind = db
    .prepare(`SELECT kind, COUNT(*) AS n FROM memories ${where} GROUP BY kind ORDER BY n DESC`)
    .all(...args);
  const byStatus = db
    .prepare(`SELECT status, COUNT(*) AS n FROM memories ${where} GROUP BY status ORDER BY n DESC`)
    .all(...args);
  const byScope = db
    .prepare(
      `SELECT CASE WHEN project_id IN (SELECT id FROM projects WHERE lower(name) = '@user') THEN 'user'
                   WHEN agent IS NOT NULL THEN 'agent' WHEN device IS NOT NULL THEN 'device'
                   ELSE 'project' END AS scope,
              COUNT(*) AS n
         FROM memories ${where} GROUP BY scope ORDER BY n DESC`,
    )
    .all(...args);
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM memories ${where}`).get(...args) as { n: number }
  ).n;
  const projects = projectId
    ? undefined
    : db
        .prepare(
          `SELECT p.id, p.name, p.root_path,
             (SELECT COUNT(*) FROM memories m WHERE m.project_id = p.id AND m.status = 'active') AS active_count,
             (SELECT MAX(m.updated_at) FROM memories m WHERE m.project_id = p.id) AS last_memory_at
           FROM projects p ORDER BY p.name`,
        )
        .all();
  return { total, byKind, byStatus, byScope, projects };
}

// ---------------------------------------------------------------------------
// Scope tree (web hierarchy navigation)
// ---------------------------------------------------------------------------

export interface ScopeCount {
  count: number;
  pinned: number;
}

export interface ScopeTreeDevice extends ScopeCount {
  /** null = the "all devices" group (device-tag absent, agent-tag present). */
  name: string | null;
  agents: Array<{ name: string } & ScopeCount>;
}

export interface ScopeTreeProject {
  id: string;
  name: string;
  root_path: string | null;
  owner_user_id: string | null;
  active_count: number;
  last_memory_at: string | null;
  /** Project-scope memories (no device/agent tags). */
  project: ScopeCount;
  /** Device groups with nested agent groups. */
  devices: ScopeTreeDevice[];
}

/**
 * Per-project scope-layer breakdown for the web tree: one GROUP BY over
 * (device, agent) tag pairs, assembled into the project → device → agent
 * hierarchy. Counts are active, non-expired memories.
 */
export function scopeCounts(db: Db, projectId: string): Pick<ScopeTreeProject, 'project' | 'devices'> {
  const rows = db
    .prepare(
      `SELECT device, agent, COUNT(*) AS count, SUM(pinned) AS pinned
         FROM memories
        WHERE project_id = ? AND status = 'active'
          AND (expires_at IS NULL OR julianday(expires_at) > julianday('now'))
        GROUP BY device, agent`,
    )
    .all(projectId) as Array<{ device: string | null; agent: string | null; count: number; pinned: number | null }>;
  const project: ScopeCount = { count: 0, pinned: 0 };
  const devices = new Map<string | null, ScopeTreeDevice>();
  for (const row of rows) {
    const count = Number(row.count);
    const pinned = Number(row.pinned ?? 0);
    if (row.device === null && row.agent === null) {
      project.count += count;
      project.pinned += pinned;
      continue;
    }
    const key = row.device;
    let node = devices.get(key);
    if (!node) {
      node = { name: row.device, count: 0, pinned: 0, agents: [] };
      devices.set(key, node);
    }
    if (row.agent === null) {
      node.count += count;
      node.pinned += pinned;
    } else {
      node.agents.push({ name: row.agent, count, pinned });
    }
  }
  // Device-scope count (agent IS NULL) is in node.count; agent rows only nest.
  return { project, devices: [...devices.values()] };
}

export function recentAudit(db: Db, options?: { projectId?: string; limit?: number }) {
  const limit = Math.max(1, Math.min(options?.limit ?? 50, 500));
  const rows = options?.projectId
    ? db
        .prepare(
          `SELECT a.id, a.ts, a.project_id, a.memory_id, a.action, a.actor, a.detail, p.name AS project_name
             FROM audit_log a LEFT JOIN projects p ON p.id = a.project_id
            WHERE a.project_id = ? ORDER BY a.id DESC LIMIT ?`,
        )
        .all(options.projectId, limit)
    : db
        .prepare(
          `SELECT a.id, a.ts, a.project_id, a.memory_id, a.action, a.actor, a.detail, p.name AS project_name
             FROM audit_log a LEFT JOIN projects p ON p.id = a.project_id
            ORDER BY a.id DESC LIMIT ?`,
        )
        .all(limit);
  return rows.map((r) => {
    const row = r as Row;
    let detail: unknown = null;
    try {
      detail = JSON.parse(String(row.detail ?? 'null'));
    } catch {
      detail = null;
    }
    return { ...row, detail };
  });
}

// ---------------------------------------------------------------------------
// Lifecycle: supersede chains & TTL sweep
// ---------------------------------------------------------------------------

/**
 * Full supersede chain containing `id`: walks up to the root memory, then
 * collects every descendant (branching allowed), oldest first.
 */
export function supersedeChain(db: Db, projectId: string, id: string): Memory[] {
  const start = requireMemory(db, projectId, id);
  let root = start;
  const guard = new Set<string>([start.id]);
  while (root.supersedes && !guard.has(root.supersedes)) {
    guard.add(root.supersedes);
    const prev = getMemory(db, root.supersedes);
    if (!prev || prev.project_id !== projectId) break;
    root = prev;
  }
  const nodes: Memory[] = [root];
  const queue: string[] = [root.id];
  while (queue.length) {
    const current = queue.shift() as string;
    const children = db
      .prepare('SELECT * FROM memories WHERE supersedes = ? AND project_id = ? ORDER BY created_at')
      .all(current, projectId) as Row[];
    for (const row of children) {
      const child = toMemory(row);
      if (nodes.some((n) => n.id === child.id)) continue;
      nodes.push(child);
      queue.push(child.id);
    }
  }
  return nodes.sort((a, b) =>
    a.created_at === b.created_at ? a.id.localeCompare(b.id) : a.created_at.localeCompare(b.created_at),
  );
}

/** Whether any other memory supersedes `id` (used to decide chain rendering). */
export function hasSuccessors(db: Db, projectId: string, id: string): boolean {
  const row = db
    .prepare('SELECT 1 AS x FROM memories WHERE supersedes = ? AND project_id = ? LIMIT 1')
    .get(id, projectId);
  return row !== undefined;
}

/**
 * Deterministic TTL garbage collection: archive every active memory whose
 * expires_at has passed. Audited as 'expire'; never deletes anything.
 */
export function sweepExpired(db: Db, actor = 'gc'): { archived: number } {
  const rows = db
    .prepare(
      `SELECT id, project_id, title FROM memories
        WHERE status = 'active' AND expires_at IS NOT NULL AND julianday(expires_at) <= julianday('now')`,
    )
    .all() as Row[];
  for (const row of rows) {
    db.prepare("UPDATE memories SET status = 'archived', updated_at = ? WHERE id = ?").run(
      nowIso(),
      String(row.id),
    );
    audit(db, String(row.project_id), String(row.id), 'expire', actor, { title: String(row.title) });
  }
  return { archived: rows.length };
}

// ---------------------------------------------------------------------------
// Review cycle (advisory: overdue memories are flagged, never hidden)
// ---------------------------------------------------------------------------

export interface OverdueEntry {
  id: string;
  project_id: string;
  title: string;
  kind: Kind;
  review_after: string;
  daysOverdue: number;
  revision_count: number;
}

/** Active memories whose review_after has passed. */
export function reviewList(db: Db, projectId?: string): OverdueEntry[] {
  const rows = db
    .prepare(
      `SELECT id, project_id, title, kind, review_after, revision_count FROM memories
        WHERE status = 'active' AND review_after IS NOT NULL AND julianday(review_after) <= julianday('now')
        ${projectId ? 'AND project_id = ?' : ''}
       ORDER BY review_after ASC LIMIT 200`,
    )
    .all(...(projectId ? [projectId] : [])) as Row[];
  return rows.map((r) => ({
    id: String(r.id),
    project_id: String(r.project_id),
    title: String(r.title),
    kind: r.kind as Kind,
    review_after: String(r.review_after),
    daysOverdue: Math.floor((Date.now() - Date.parse(String(r.review_after))) / 86_400_000),
    revision_count: Number(r.revision_count ?? 1),
  }));
}

/** Mark a memory reviewed: review_after restarts at the kind's default interval. */
export function markReviewed(db: Db, projectId: string, id: string, actor?: string | null): Memory {
  const prev = requireMemory(db, projectId, id);
  const next = defaultReviewAfter(prev.kind, nowIso()) ?? new Date(Date.now() + 180 * 86_400_000).toISOString();
  recordRevision(db, prev, 'review', actor ?? null);
  db.prepare('UPDATE memories SET review_after = ?, version = version + 1, updated_at = ? WHERE id = ?').run(
    next,
    nowIso(),
    id,
  );
  audit(db, projectId, id, 'review', actor ?? null, { previous: prev.review_after, next });
  const updated = getMemory(db, id);
  if (!updated) throw new HiveMemError('DB_ERROR', '复审后读取失败');
  return updated;
}

/** Embedding index stats for memory_stats / status output. */
export function embeddingStats(db: Db): {
  model: string | null;
  dim: number | null;
  embedded: number;
  total: number;
} {
  const meta = db
    .prepare('SELECT model_name, dim FROM embedding_meta WHERE id = 1')
    .get() as { model_name: string; dim: number } | undefined;
  const embedded = (db.prepare('SELECT COUNT(*) AS n FROM memory_embeddings').get() as { n: number }).n;
  const total = (db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n;
  return { model: meta?.model_name ?? null, dim: meta?.dim ?? null, embedded, total };
}
