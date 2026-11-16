/**
 * HiveMem brief injection for DSH.
 *
 * Why a plugin and not instructions: HiveMem's first step used to depend on the
 * model choosing to call `memory_bootstrap`. A hook that runs before every step
 * removes that choice — the project brief is present in the request whether or
 * not the model remembers to ask, which is the same bet PowerContext makes with
 * its `prepare` hook.
 *
 * Two moving parts, deliberately split by async-ness:
 *  - `agent/pre-step` (async, once per TTL window) reads `GET /api/brief` for
 *    the session's working directory;
 *  - `systemPrompt.context` (sync, every assembly) returns the cached text, so
 *    prompt assembly never waits on the network. Failures fail open: no text is
 *    injected and the previous text is kept.
 *
 * @module hivemem-dsh
 */
import { BriefCache, DEFAULT_CONFIG, resolveDevice, resolveProjectName } from './core.js';

/** Cordis plugin name, used in loader diagnostics. */
export const name = 'hivemem-brief';

/**
 * `systemPrompt` provides the dynamic-context registry; `workingDirectory` is
 * optional at runtime (a headless composition may not mount it), so it is
 * required here only for the service we cannot work without.
 */
export const inject = ['systemPrompt'];

/** Context order: after the working directory (100), before harness source (200). */
const CONTEXT_ORDER = 150;

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function makeLog(ctx) {
  return (message, level = 'info') => {
    const line = `${name}: ${message}`;
    try {
      const logger = ctx.logger;
      if (logger && typeof logger[level] === 'function') logger[level](line);
      else if (typeof logger === 'function') logger(line);
      else console.error(line);
    } catch {
      /* logging must never take the step down */
    }
  };
}

/** Session working directory plus where it came from, for diagnostics. */
function resolveCwd(ctx, agent) {
  const session = agent?.session;
  // The working directory is a first-class service, but this plugin treats it
  // as optional (headless compositions may not mount it) — so it is read
  // through `ctx.reflect`, which is the injection-free store read. Reading
  // `ctx.workingDirectory` directly throws without a matching `inject`.
  try {
    const registry = ctx.reflect;
    const service = typeof registry?.get === 'function' ? registry.get('workingDirectory') : undefined;
    if (session && service && typeof service.get === 'function') {
      const dir = service.get(session);
      if (typeof dir === 'string' && dir.trim()) return { cwd: dir, source: 'service' };
    }
  } catch {
    /* fall through to the durable header */
  }
  // The session header keeps the directory the session was created in. It is
  // not affected by service start-up ordering: reading a not-yet-initialised
  // projection yields the deployment default (the host's own cwd), and a brief
  // for the wrong project is worse than no brief at all.
  try {
    const headerCwd = session?.header?.cwd;
    if (typeof headerCwd === 'string' && headerCwd.trim()) return { cwd: headerCwd, source: 'header' };
  } catch {
    /* fall through to the process directory */
  }
  return { cwd: process.cwd(), source: 'process' };
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ baseUrl?: string, project?: string, token?: string, maxChars?: number,
 *           ttlMs?: number, timeoutMs?: number, contextOrder?: number,
 *           device?: string, agent?: string, enabled?: boolean }} [config]
 */
export function apply(ctx, config = {}) {
  const log = makeLog(ctx);
  if (config.enabled === false) {
    log('disabled by config; no brief will be injected', 'info');
    return;
  }

  // Scope headers decide which device/agent layers the hub includes. Without
  // them the hub falls back to its own hostname, silently dropping both.
  const device = resolveDevice(config.device ?? process.env.HIVEMEM_DEVICE ?? DEFAULT_CONFIG.device);
  const agent = String(config.agent ?? process.env.HIVEMEM_AGENT ?? DEFAULT_CONFIG.agent).trim() || DEFAULT_CONFIG.agent;

  const cache = new BriefCache({
    baseUrl: String(config.baseUrl ?? process.env.HIVEMEM_HUB_URL ?? DEFAULT_CONFIG.baseUrl).replace(/\/+$/, ''),
    token: String(config.token ?? process.env.HIVEMEM_TOKEN ?? ''),
    maxChars: numberOr(config.maxChars, DEFAULT_CONFIG.maxChars),
    ttlMs: numberOr(config.ttlMs, DEFAULT_CONFIG.ttlMs),
    timeoutMs: numberOr(config.timeoutMs, DEFAULT_CONFIG.timeoutMs),
    device,
    agent,
    onError: (error) => log(`brief refresh failed (keeping last text): ${String(error?.message ?? error)}`, 'warn'),
    onNotice: (kind, project) =>
      log(
        kind === 'missing'
          ? `project ${project} is not registered on the hub; a one-line notice replaces the brief`
          : `brief for ${project} exceeds maxChars; a one-line notice replaces it (raise maxChars or lower the server budget)`,
        'warn',
      ),
  });

  // Prefetch: async, deduplicated per project, fail-open.
  let warnedFallback = false;
  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      if (!payload?.signal?.aborted) {
        const { cwd, source } = resolveCwd(ctx, payload?.agent);
        // The process fallback is the host's own directory, not the session's:
        // the project name derived from it is almost certainly wrong, and the
        // injected notice will say so. Warn once, not once per step.
        if (source === 'process' && !warnedFallback) {
          warnedFallback = true;
          log(
            `no session directory from the working-directory service; falling back to ${cwd} (project names from this directory may be wrong)`,
            'warn',
          );
        }
        const project = resolveProjectName(config.project, cwd);
        const before = cache.current;
        await cache.ensure(project, { signal: payload.signal, cwd });
        const after = cache.current;
        if (after && after !== before) {
          log(`injected ${after.rendered.length} chars (${after.kind}) for project ${after.project}`, 'info');
        }
      }
    } catch (error) {
      // Never reject a step because memory is unavailable.
      log(`pre-step injection skipped: ${String(error?.message ?? error)}`, 'warn');
    }
    return next();
  });

  // Assembly: sync read of whatever the pre-step hook last resolved.
  ctx.systemPrompt.context({
    name: 'hivemem:brief',
    order: numberOr(config.contextOrder, CONTEXT_ORDER),
    text: () => cache.text(),
  });
}

/** Exposed for tests and diagnostics (`cache.stats` survives across steps). */
export { BriefCache } from './core.js';
