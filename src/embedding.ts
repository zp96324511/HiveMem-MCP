/**
 * Embedding provider: any OpenAI-compatible /v1/embeddings endpoint
 * (OpenAI, Ollama, LM Studio, vLLM, SiliconFlow, self-hosted bge, …).
 *
 * Configuration via environment variables:
 *   HIVEMEM_EMBEDDING_URL   base URL or full endpoint, both accepted:
 *                           http://host:port/v1  or  http://host:port/v1/embeddings
 *   HIVEMEM_EMBEDDING_MODEL e.g. text-embedding-3-small     (default below)
 *   HIVEMEM_EMBEDDING_KEY   optional bearer key
 *
 * When no URL is configured, HiveMem stays fully functional on lexical
 * retrieval; semantic search is an opt-in layer.
 */

export interface Embedder {
  readonly modelName: string;
  /** 0 until the first successful call reveals it. */
  dimension: number;
  embed(texts: string[]): Promise<number[][]>;
}

const DEFAULT_MODEL = 'text-embedding-3-small';
const TIMEOUT_MS = 30_000;

/** Accepts both a base URL and a full /embeddings endpoint; returns the endpoint. */
export function embeddingsEndpoint(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  return trimmed.endsWith('/embeddings') ? trimmed : `${trimmed}/embeddings`;
}

export function createEmbedderFromEnv(env: NodeJS.ProcessEnv = process.env): Embedder | null {
  const rawUrl = env.HIVEMEM_EMBEDDING_URL?.trim();
  if (!rawUrl) return null;
  const endpoint = embeddingsEndpoint(rawUrl);
  const model = env.HIVEMEM_EMBEDDING_MODEL?.trim() || DEFAULT_MODEL;
  const apiKey = env.HIVEMEM_EMBEDDING_KEY?.trim() || undefined;

  return {
    modelName: model,
    dimension: 0,
    async embed(texts: string[]): Promise<number[][]> {
      if (!texts.length) return [];
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ input: texts, model }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`embedding API ${response.status}: ${detail.slice(0, 200)}`);
      }
      const json = (await response.json()) as {
        data?: Array<{ embedding?: number[] }>;
      };
      const vectors = (json.data ?? []).map((d) => d.embedding ?? []);
      if (vectors.length !== texts.length || vectors.some((v) => !v.length)) {
        throw new Error('embedding API returned mismatched payload');
      }
      this.dimension = vectors[0].length;
      return vectors;
    },
  };
}
