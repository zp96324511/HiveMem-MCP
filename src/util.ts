import { randomUUID } from 'node:crypto';

/** Current time as an ISO-8601 UTC string. */
export const nowIso = (): string => new Date().toISOString();

/** Fresh opaque memory id, e.g. mem_9f2a7c…. */
export const newMemoryId = (): string => `mem_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

/** Fresh opaque project id, e.g. prj_3f9a7c…. */
export const newProjectId = (): string => `prj_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

/** Fresh opaque user id, e.g. usr_3f9a7c…. */
export const newUserId = (): string => `usr_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

/** Fresh opaque token id, e.g. tok_3f9a7c…. */
export const newTokenId = (): string => `tok_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

/** Fresh opaque session id, e.g. ses_3f9a7c…. */
export const newSessionId = (): string => `ses_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

/** Domain error carrying a stable machine-readable code plus an optional next-step hint. */
export class HiveMemError extends Error {
  readonly code: string;
  readonly hint?: string;
  readonly detail?: unknown;

  constructor(code: string, message: string, options?: { hint?: string; detail?: unknown }) {
    super(message);
    this.name = 'HiveMemError';
    this.code = code;
    this.hint = options?.hint;
    this.detail = options?.detail;
  }
}

/** Number of Unicode code points in a string (not UTF-16 units). */
export const runeLength = (s: string): number => [...s].length;

/** Clip a string to at most `max` code points, appending an ellipsis when cut. */
export const clip = (s: string, max: number): string => {
  const runes = [...s];
  return runes.length <= max ? s : runes.slice(0, max).join('') + '…';
};

export const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
