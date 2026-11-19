/**
 * Semantic layer: Float32-BLOB vector storage, brute-force cosine retrieval,
 * MemPalace-style three-state embedder identity checking, and hybrid search
 * that blends semantic + lexical + recency + importance + pin + kind.
 *
 * Design notes:
 * - node:sqlite cannot load extensions, so no sqlite-vec: vectors live as
 *   BLOBs and similarity is computed in JS. At personal-hub scale (≤ a few
 *   thousand memories) this is single-digit milliseconds.
 * - Embeddings are derived state: a failed embed never fails a memory write.
 * - Identity mismatch never silently degrades: search falls back to lexical
 *   and the result carries an explicit warning with the repair command.
 */

import type { Db } from './db.js';
import type { Embedder } from './embedding.js';
import { scopeCondition } from './scope.js';
import * as store from './store.js';
import type { Memory, SearchHit, SearchOptions, SearchResult } from './store.js';
import { HiveMemError, clip, nowIso } from './util.js';

// ---------------------------------------------------------------------------
// BLOB <-> Float32Array
// ---------------------------------------------------------------------------

const toBlob = (vector: number[]): Buffer => {
  const f32 = new Float32Array(vector);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
};

const fromBlob = (blob: Uint8Array): Float32Array => {
  const copy = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength) as ArrayBuffer;
  return new Float32Array(copy);
};

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const norm = Math.sqrt(na) * Math.sqrt(nb);
  return norm > 0 ? dot / norm : 0;
}

// ---------------------------------------------------------------------------
// Embedder identity (three-state, per MemPalace RFC 001)
// ---------------------------------------------------------------------------

export interface EmbeddingMeta {
  model_name: string;
  dim: number;
}

export function getMeta(db: Db): EmbeddingMeta | null {
  const row = db
    .prepare('SELECT model_name, dim FROM embedding_meta WHERE id = 1')
    .get() as { model_name: string; dim: number } | undefined;
  return row ?? null;
}

export function recordMeta(db: Db, embedder: Embedder): void {
  if (!embedder.dimension) return;
  db.prepare(
    `INSERT INTO embedding_meta (id, model_name, dim, updated_at)
     VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET model_name = excluded.model_name, dim = excluded.dim, updated_at = excluded.updated_at`,
  ).run(embedder.modelName, embedder.dimension, nowIso());
}

export type IdentityState = 'unknown' | 'match' | 'mismatch';

/** Three-state check: unknown (no meta yet), match, mismatch (model or dim differs). */
export function checkIdentity(db: Db, embedder: Embedder): IdentityState {
  const meta = getMeta(db);
  if (!meta) return 'unknown';
  if (meta.model_name !== embedder.modelName) return 'mismatch';
  if (embedder.dimension && meta.dim !== embedder.dimension) return 'mismatch';
  return 'match';
}

export function countEmbeddings(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM memory_embeddings').get() as { n: number }).n;
}

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

/**
 * Character budget for the text sent to the embedder. Default 480 is safe for
 * 512-token models (bge family: ~1 CJK char per token); override with
 * HIVEMEM_EMBEDDING_MAX_CHARS for long-context models (e.g. 8k for
 * text-embedding-3-small). The title comes first so truncation keeps the gist.
 */
const embedTextMax = (): number => {
  const raw = Number(process.env.HIVEMEM_EMBEDDING_MAX_CHARS);
  return Number.isFinite(raw) && raw > 0 ? raw : 480;
};

export const embedTextFor = (m: Memory): string =>
  clip(`${m.title}\n${m.content}`, embedTextMax());

/**
 * Embed one memory after write. Best effort by contract: identity mismatch,
 * API failure, or a missing embedder never throws — degradation is logged so
 * the memory itself always survives.
 */
export async function embedMemoryBestEffort(
  db: Db,
  embedder: Embedder | null | undefined,
  memory: Memory,
): Promise<void> {
  if (!embedder) return;
  try {
    const state = checkIdentity(db, embedder);
    if (state === 'mismatch') {
      console.error(
        `[hivemem] 嵌入模型不匹配（库内 ${getMeta(db)?.model_name}，当前 ${embedder.modelName}），跳过向量索引。运行 hivemem repair-embeddings 重建。`,
      );
      return;
    }
    const [vector] = await embedder.embed([embedTextFor(memory)]);
    db.prepare(
      `INSERT INTO memory_embeddings (memory_id, model_name, dim, vector, embedded_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(memory_id) DO UPDATE SET model_name = excluded.model_name, dim = excluded.dim, vector = excluded.vector, embedded_at = excluded.embedded_at`,
    ).run(memory.id, embedder.modelName, vector.length, toBlob(vector), nowIso());
    if (state === 'unknown') recordMeta(db, embedder);
  } catch (error) {
    console.error(
      `[hivemem] 嵌入失败（记忆 ${memory.id}，已保留写入，!跳过向量索引）:`,
      error instanceof Error ? error.message : error,
    );
  }
}

// ---------------------------------------------------------------------------
// Hybrid search
// ---------------------------------------------------------------------------

/** Recency + importance + pin + kind component shared by both scoring paths. */
function restScore(m: Memory): number {
  const ageDays = Math.max(0, (Date.now() - Date.parse(m.updated_at)) / 86_400_000);
  const recency = Number.isFinite(ageDays) ? Math.exp(-ageDays / 30) : 0;
  const kindW =
    ({ decision: 1, fact: 0.8, preference: 0.8, procedure: 0.7, snippet: 0.5, episodic: 0.4 } as Record<string, number>)[
      m.kind
    ] ?? 0.5;
  return 0.2 * recency + 0.15 * m.importance + 0.1 * (m.pinned ? 1 : 0) + 0.1 * kindW; // max 0.55
}

const MISMATCH_WARNING =
  '嵌入模型与库内索引不一致，本次已降级为词法检索；运行 hivemem repair-embeddings 重建向量索引。';
const NO_INDEX_WARNING =
  '已配置嵌入模型但尚无向量索引，本次为词法检索；运行 hivemem repair-embeddings 为存量记忆构建索引。';

/** Env number with a sane fallback: unset / NaN / negative → default. */
const numberEnv = (name: string, fallback: number): number => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
};

/**
 * Semantic admission gate (used by hybridSearch). bge-family Chinese models
 * place *unrelated* pairs at cosine ~0.30-0.45 (embedding anisotropy), so the
 * old `if (score > 0)` check admitted the entire corpus: every query returned
 * `total = corpus size`, and metadata (pin/recency/importance, budget 0.30)
 * outranked relevance. Two limits combine:
 *
 *   - an absolute floor, calibrated per model family (env-overridable);
 *   - a cut relative to the query's own best hit, for corpora that sit
 *     uniformly high or low for a given query.
 *
 * Pure lexical hits bypass the gate: matching text is evidence on its own.
 */
const SEMANTIC_MIN_SCORE = (): number => numberEnv('HIVEMEM_SEMANTIC_MIN_SCORE', 0.4);
const SEMANTIC_MARGIN = (): number => numberEnv('HIVEMEM_SEMANTIC_MARGIN', 0.12);

/**
 * Reciprocal-rank fusion (Cormack et al. 2009). Rank-based fusion is the
 * portable choice here: raw cosine scales differ per model (bge ~0.3-0.7,
 * OpenAI ~0.0-0.3), while rank order stays comparable. k=10 (not the classic
 * 60) because candidate sets are ≤100; `score` is scaled so "first in both
 * paths" → 1.0 and "first in one path" → 0.5.
 */
const RRF_K = 10;
const RRF_SCALE = 5;

/**
 * Lexical search plus optional semantic layer. When an embedder is configured,
 * the query is embedded and compared (cosine) against all vectors of the
 * filtered scope. Candidates are admitted by the semantic gate and then fused
 * by reciprocal rank (see RRF_K); metadata (recency/importance/pin/kind) only
 * breaks ties, it never outranks relevance:
 *
 *   score = 5·(1/(10+rank_sem) + 1/(10+rank_lex))
 *
 * Lexical-only fallback keeps the classic 0.45·text + rest formula.
 */
export async function hybridSearch(
  db: Db,
  embedder: Embedder | null | undefined,
  options: SearchOptions,
): Promise<SearchResult> {
  const warnings: string[] = [];
  // An explicitly empty project set means "nothing accessible" — the semantic
  // scan below must not fall through to an unfiltered scan either.
  if (options.projectIds && options.projectIds.length === 0) {
    return { hits: [], total: 0, mode: 'browse', warnings };
  }
  // offset is applied exactly once, after fusion: passing it down here shifted
  // the lexical pool and then the fused slice shifted it again (page 2 lost rows).
  const lexical = store.searchMemories(db, {
    ...options,
    offset: 0,
    limit: Math.max(options.limit ?? 20, 100),
  });
  const query = options.query?.trim();
  if (!embedder || !query) {
    return { ...lexical, warnings };
  }

  // Budget mode (Memorix-inspired): HIVEMEM_SEMANTIC_MODE=fallback embeds the
  // query only when lexical retrieval found nothing — cheaper for metered or
  // flaky embedding endpoints. Default is "always" (constant hybrid blending).
  if (process.env.HIVEMEM_SEMANTIC_MODE?.trim() === 'fallback' && lexical.hits.length > 0) {
    return { ...store.searchMemories(db, options), warnings };
  }

  const state = checkIdentity(db, embedder);
  if (state === 'mismatch') {
    warnings.push(MISMATCH_WARNING);
    return { ...store.searchMemories(db, options), warnings };
  }
  if (countEmbeddings(db) === 0) {
    warnings.push(NO_INDEX_WARNING);
    return { ...store.searchMemories(db, options), warnings };
  }

  let queryVector: number[];
  try {
    [queryVector] = await embedder.embed([query]);
  } catch (error) {
    warnings.push(
      `嵌入查询失败，已降级为词法检索：${error instanceof Error ? error.message.slice(0, 120) : error}`,
    );
    return { ...store.searchMemories(db, options), warnings };
  }
  if (state === 'unknown') recordMeta(db, embedder);

  // Semantic candidates: all embedded memories within the same SQL scope.
  const conds: string[] = ["(m.expires_at IS NULL OR julianday(m.expires_at) > julianday('now'))"];
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
  } else {
    conds.push("m.status = 'active'");
  }
  if (options.kind) {
    conds.push('m.kind = ?');
    params.push(options.kind);
  }
  for (const tag of options.tags ?? []) {
    conds.push("m.tags LIKE ? ESCAPE '\\'");
    params.push(`%${tag.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
  }

  const rows = db
    .prepare(
      `SELECT e.memory_id AS id, e.vector FROM memory_embeddings e
         JOIN memories m ON m.id = e.memory_id
       WHERE ${conds.join(' AND ')}`,
    )
    .all(...params) as Array<{ id: string; vector: Uint8Array }>;

  const queryF32 = new Float32Array(queryVector);
  const semantic = new Map<string, number>();
  for (const row of rows) {
    const score = cosine(queryF32, fromBlob(row.vector));
    if (score > 0) semantic.set(row.id, score);
  }

  // Admission: drop vectors that carry no relevance evidence. Without this,
  // every active memory is a "hit" for every query and the ranking degenerates
  // into a metadata sort (see SEMANTIC_MIN_SCORE).
  const scanned = rows.length;
  const semTop = semantic.size ? Math.max(...semantic.values()) : 0;
  const semFloor = Math.max(SEMANTIC_MIN_SCORE(), semTop - SEMANTIC_MARGIN());
  for (const [id, score] of [...semantic]) {
    if (score < semFloor) semantic.delete(id);
  }

  // Union candidates: lexical hits + gated semantic hits.
  const byId = new Map<string, { m: Memory; text: number }>();
  for (const hit of lexical.hits) byId.set(hit.id, { m: hit, text: hit.textScore });
  const missing = [...semantic.keys()].filter((id) => !byId.has(id));
  if (missing.length) {
    const placeholders = missing.map(() => '?').join(',');
    const extraRows = db
      .prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`)
      .all(...missing) as Array<Record<string, unknown>>;
    for (const row of extraRows) {
      const m = row as unknown as store.Memory;
      // Rebuild via the canonical parser to keep tags/status typing honest.
      const parsed = store.getMemory(db, m.id);
      if (parsed) byId.set(parsed.id, { m: parsed, text: 0 });
    }
  }

  // Reciprocal-rank fusion over both paths; metadata only breaks ties.
  const semRank = new Map<string, number>();
  [...semantic.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([id], i) => semRank.set(id, i));
  const lexRank = new Map<string, number>();
  [...lexical.hits]
    .sort((a, b) => b.textScore - a.textScore)
    .forEach((hit, i) => lexRank.set(hit.id, i));
  const rrfShare = (rank: number | undefined): number => (rank === undefined ? 0 : 1 / (RRF_K + rank));
  const fused = (id: string): number =>
    Math.min(1, RRF_SCALE * (rrfShare(semRank.get(id)) + rrfShare(lexRank.get(id))));

  const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
  const offset = Math.max(0, options.offset ?? 0);
  const overdue = (m: store.Memory): boolean =>
    m.review_after !== null && Number.isFinite(Date.parse(m.review_after)) && Date.parse(m.review_after) <= Date.now();
  const scored: Array<{ hit: SearchHit; raw: number }> = [];
  for (const [id, entry] of byId) {
    const sem = semantic.get(id) ?? null;
    const fromSemantic = semRank.has(id);
    const fromLexical = lexRank.has(id);
    const raw = fused(id);
    scored.push({
      raw,
      hit: {
        ...entry.m,
        score: Math.round(raw * 1000) / 1000,
        textScore: Math.round(entry.text * 1000) / 1000,
        semanticScore: sem === null ? null : Math.round(sem * 1000) / 1000,
        relevance: sem === null ? null : Math.round(sem * 1000) / 1000,
        matched: fromSemantic && fromLexical ? 'both' : fromSemantic ? 'semantic' : 'lexical',
        needsReview: overdue(entry.m),
        snippet: clip(entry.m.content.replace(/\s+/g, ' '), 160),
      },
    });
  }
  scored.sort(
    (a, b) => b.raw - a.raw || restScore(b.hit) - restScore(a.hit) || a.hit.id.localeCompare(b.hit.id),
  );

  return {
    hits: scored.slice(offset, offset + limit).map(({ hit }) => hit),
    total: scored.length,
    scanned,
    mode: 'hybrid',
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Reindex
// ---------------------------------------------------------------------------

export interface ReindexResult {
  embedded: number;
  model: string;
  dim: number;
}

/**
 * (Re-)embed every memory with the current model and refresh the identity
 * meta. Required after switching embedding models; safe to re-run.
 */
export async function reindexEmbeddings(
  db: Db,
  embedder: Embedder,
  options?: { force?: boolean },
): Promise<ReindexResult> {
  const meta = getMeta(db);
  if (!options?.force && meta && meta.model_name === embedder.modelName && countEmbeddings(db) > 0) {
    return { embedded: 0, model: meta.model_name, dim: meta.dim };
  }
  const memories = db.prepare('SELECT id FROM memories ORDER BY created_at').all() as Array<{
    id: string;
  }>;
  const BATCH = 64;
  let embedded = 0;
  for (let start = 0; start < memories.length; start += BATCH) {
    const batch = memories.slice(start, start + BATCH);
    const texts = batch.map((row) => {
      const m = store.getMemory(db, row.id);
      return m ? embedTextFor(m) : '';
    });
    const usable = texts.some((t) => t);
    if (!usable) continue;
    const vectors = await embedder.embed(texts);
    for (let i = 0; i < batch.length; i++) {
      const text = texts[i];
      const vector = vectors[i];
      if (!text || !vector?.length) continue;
      db.prepare(
        `INSERT INTO memory_embeddings (memory_id, model_name, dim, vector, embedded_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(memory_id) DO UPDATE SET model_name = excluded.model_name, dim = excluded.dim, vector = excluded.vector, embedded_at = excluded.embedded_at`,
      ).run(batch[i].id, embedder.modelName, vector.length, toBlob(vector), nowIso());
      embedded++;
    }
  }
  recordMeta(db, embedder);
  return { embedded, model: embedder.modelName, dim: embedder.dimension };
}

export function requireEmbedder(embedder: Embedder | null | undefined): Embedder {
  if (!embedder) {
    throw new HiveMemError('EMBEDDER_NOT_CONFIGURED', '未配置嵌入模型。设置 HIVEMEM_EMBEDDING_URL（及可选 MODEL/KEY）后重试。', {
      hint: '例：HIVEMEM_EMBEDDING_URL=http://localhost:11434/v1 HIVEMEM_EMBEDDING_MODEL=bge-m3',
    });
  }
  return embedder;
}
