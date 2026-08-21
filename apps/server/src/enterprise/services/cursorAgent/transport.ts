import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';

import { CURSOR_ACCOUNT_HEADER } from '@lobechat/model-runtime';

import { resolveCursorAgentConfigSeedDir } from './configSeed';
import { buildCursorAgentChildEnv, ensureCursorAgentStateDir } from './env';
import { CursorAgentPolicyError, CursorAgentUnavailableError } from './errors';
import { getCachedCursorModels, resetCursorModelsCache, runListModels } from './models';
import { resolveCursorCliCached } from './resolveCli';
import { createAbortError, jsonError, mapGateError, TurnGate } from './transport.gate';
import type { TurnRequest } from './transport.parseTurn';
import { parseTurnBody } from './transport.parseTurn';
import { relayCliStream, trimErrorMessage } from './transport.relay';
import type { CursorConfigSeedGeneration, CursorScratch, TurnScratch } from './transport.scratch';
import {
  copyTurnConfigSeedBack,
  createScratchRoot,
  removeScratch,
  seedTurnConfig,
  writeTurnScratch,
} from './transport.scratch';

export { resetCursorModelsCache };
export type { CursorConfigSeedGeneration } from './transport.scratch';

const ORIGIN_HOST = 'cursor.local';
const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_MAX_QUEUE = 16;
const DEFAULT_TURN_TIMEOUT_MS = 600_000;
const DEFAULT_QUEUE_TIMEOUT_MS = 60_000;
const MODELS_TIMEOUT_MS = 60_000;

export const CURSOR_AGENT_MAX_CONCURRENCY_ENV = 'CURSOR_AGENT_MAX_CONCURRENCY';
export const CURSOR_AGENT_MAX_QUEUE_ENV = 'CURSOR_AGENT_MAX_QUEUE';
export const CURSOR_AGENT_TURN_TIMEOUT_MS_ENV = 'CURSOR_AGENT_TURN_TIMEOUT_MS';

const FETCH_CACHE_MAX = 4;
const keyed = new Map<string, { fetch: typeof fetch; lastUsed: number }>();

export interface CursorAgentFetchOptions {
  maxConcurrency?: number;
  maxQueue?: number;
  proxyUrl?: string | null;
  queueTimeoutMs?: number;
  turnTimeoutMs?: number;
}

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const MAX_ACCOUNT_ID_CHARS = 512;

const hasControlChars = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.codePointAt(index)!;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
};

const extractBearerToken = (headers: Headers): string | undefined => {
  const header = headers.get('authorization');
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)/i.exec(header.trim());
  const token = match?.[1];
  if (!token || hasControlChars(token)) return undefined;
  return token;
};

/**
 * Private hop-by-hop account id. Ill-formed values are dropped (the seed then keys
 * off the bearer digest) rather than failing the request. The header is never copied
 * into env, argv, the history file, or logs.
 */
const extractAccountId = (headers: Headers): string | undefined => {
  const raw = headers.get(CURSOR_ACCOUNT_HEADER)?.trim();
  if (!raw || raw.length > MAX_ACCOUNT_ID_CHARS || hasControlChars(raw)) return undefined;
  return raw;
};

const parseRequest = (input: RequestInfo | URL, init?: RequestInit): Request => {
  if (input instanceof Request) {
    return init ? new Request(input, init) : input;
  }
  return new Request(String(input), init);
};

const assertCursorLocal = (url: URL): void => {
  if (url.protocol !== 'https:' || url.hostname !== ORIGIN_HOST) {
    throw new CursorAgentPolicyError(`refuses ${url.protocol}//${url.hostname}`);
  }
};

/**
 * Print-mode argv. Hidden flags (`--allowed-tools`, `--single-turn`, `--disable-*`)
 * are present in this CLI build (2026.08.11-e8db854) even though `cursor-agent --help`
 * hides them — confirmed by commander accepting them without "unknown option".
 *
 * `--exclude-workspace-context` is accepted by commander but the Agent server
 * returns `[invalid_argument] Workspace context exclusion is not allowed for this
 * user, team, or selected model` (live, 2026-08-17), so it is omitted.
 *
 * `--new-session-id <uuid>` is a hidden root option that DOES apply to `-p`
 * (verified live, 2026-08-18: the emitted `session_id` on every stream-json line
 * equals the value passed). The CLI claims the id by creating its session directory,
 * so it must be unique per config dir — which it is: every turn gets a fresh
 * `CURSOR_CONFIG_DIR`. It cannot be combined with `--resume` / `--continue`, and we
 * use neither: history is replayed through `--conversation-history-file`.
 *
 * `--allowed-tools` takes proto `ToolCall` oneof field names
 * (`update_todos_tool_call`, `web_search_tool_call`, …), not the user-facing
 * permission string `WebSearch`. Confirmed against cursor-agent 2026.08.11-e8db854.
 */
export const CURSOR_WEB_SEARCH_TOOL = 'web_search_tool_call';
const CURSOR_TODOS_TOOL = 'update_todos_tool_call';

export const buildTurnArgv = (turn: TurnRequest, scratch: TurnScratch): string[] => {
  const allowedTools = turn.enabledSearch
    ? `${CURSOR_TODOS_TOOL},${CURSOR_WEB_SEARCH_TOOL}`
    : CURSOR_TODOS_TOOL;
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--stream-partial-output',
    '--mode',
    'ask',
    '--single-turn',
    '--trust',
    '--disable-indexing',
    '--disable-codebase-ref',
    '--disable-auto-update',
    '--disable-project-configs',
    '--allowed-tools',
    allowedTools,
    '--model',
    turn.model,
    '--conversation-history-file',
    scratch.historyPath,
  ];
  if (turn.sessionId) {
    args.push('--new-session-id', turn.sessionId);
  }
  for (const path of scratch.imagePaths) {
    args.push('--image', path);
  }
  args.push('--', turn.prompt);
  return args;
};

const spawnCursor = (
  cliArgs: string[],
  options: { cwd: string; env: Record<string, string> },
): ChildProcessWithoutNullStreams => {
  const resolved = resolveCursorCliCached();
  return spawn(resolved.command, [...resolved.args, ...cliArgs], {
    cwd: options.cwd,
    // The child env is intentionally a clean allowlist, not the process env; the
    // ProcessEnv augmentation only describes what THIS process expects.
    env: options.env as NodeJS.ProcessEnv,
    stdio: 'pipe',
  });
};

/**
 * fetch-compatible transport that intercepts `https://cursor.local/*` and spawns
 * the Cursor CLI. Anything else is refused (the child is invisible to the SSRF stack).
 */
export const createCursorAgentFetch = (options: CursorAgentFetchOptions = {}): typeof fetch => {
  const maxConcurrency =
    options.maxConcurrency ??
    parsePositiveInt(process.env[CURSOR_AGENT_MAX_CONCURRENCY_ENV], DEFAULT_MAX_CONCURRENCY);
  const maxQueue =
    options.maxQueue ??
    parsePositiveInt(process.env[CURSOR_AGENT_MAX_QUEUE_ENV], DEFAULT_MAX_QUEUE);
  const turnTimeoutMs =
    options.turnTimeoutMs ??
    parsePositiveInt(process.env[CURSOR_AGENT_TURN_TIMEOUT_MS_ENV], DEFAULT_TURN_TIMEOUT_MS);
  const queueTimeoutMs = options.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS;
  const gate = new TurnGate(maxConcurrency, maxQueue);
  const proxyUrl = options.proxyUrl;

  const cursorFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = parseRequest(input, init);
    const url = new URL(request.url);
    assertCursorLocal(url);

    if (request.signal?.aborted) throw createAbortError();

    let cliReady: ReturnType<typeof resolveCursorCliCached>;
    try {
      cliReady = resolveCursorCliCached();
    } catch (error) {
      if (error instanceof CursorAgentUnavailableError) {
        return jsonError(503, 'cli_unavailable', error.message);
      }
      throw error;
    }
    void cliReady;

    const token = extractBearerToken(request.headers);
    if (!token) return jsonError(401, 'unauthorized', 'missing bearer token');

    const accountId = extractAccountId(request.headers);
    // Hop-by-hop only: drop before any CLI-facing work. Request headers are not
    // forwarded to spawn; this is belt-and-suspenders against a future copy.
    try {
      request.headers.delete(CURSOR_ACCOUNT_HEADER);
    } catch {
      // `Request.headers` is immutable in some runtimes; the CLI never sees them.
    }

    const state = ensureCursorAgentStateDir();
    const accountSeedDir = () =>
      resolveCursorAgentConfigSeedDir({
        seedRoot: state.configSeed,
        token,
        ...(accountId ? { accountId } : {}),
      });

    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'GET' && pathname === '/v1/models') {
      const cached = getCachedCursorModels(token);
      if (cached) {
        return new Response(JSON.stringify({ models: cached }), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        });
      }

      // Admission first: a rejected request must not touch the shared config seed.
      try {
        await gate.acquire(queueTimeoutMs, request.signal);
      } catch (error) {
        const mapped = mapGateError(error);
        if (mapped) return mapped;
        throw error;
      }

      let scratch: CursorScratch | undefined;
      // Assigned by the staging step below; the handler returns early when that throws.
      let seedGeneration: CursorConfigSeedGeneration;
      let configSeedDir: string;
      try {
        configSeedDir = accountSeedDir();
        scratch = createScratchRoot(state.turns);
        seedGeneration = seedTurnConfig(configSeedDir, scratch.configDir);
      } catch (error) {
        gate.release();
        removeScratch(scratch?.root);
        const detail = error instanceof Error ? error.message : 'failed to stage model files';
        return jsonError(503, 'cli_error', trimErrorMessage(detail, token));
      }

      const env = buildCursorAgentChildEnv({
        proxyUrl,
        stateDir: state.root,
        token,
        turnRoot: scratch.root,
      });
      try {
        return await runListModels({
          cwd: scratch.root,
          env,
          signal: request.signal,
          timeoutMs: Math.min(turnTimeoutMs, MODELS_TIMEOUT_MS),
          token,
        });
      } catch (error) {
        if (error instanceof CursorAgentUnavailableError) {
          return jsonError(503, 'cli_unavailable', error.message);
        }
        throw error;
      } finally {
        copyTurnConfigSeedBack(scratch.configDir, configSeedDir, seedGeneration);
        removeScratch(scratch.root);
        gate.release();
      }
    }

    if (request.method === 'POST' && pathname === '/v1/turn') {
      const parsed = await parseTurnBody(request);
      if (parsed instanceof Response) return parsed;

      try {
        await gate.acquire(queueTimeoutMs, request.signal);
      } catch (error) {
        const mapped = mapGateError(error);
        if (mapped) return mapped;
        throw error;
      }

      let scratch: TurnScratch | undefined;
      // Assigned by the staging step below; the handler returns early when that throws.
      let seedGeneration: CursorConfigSeedGeneration;
      let configSeedDir: string;
      try {
        configSeedDir = accountSeedDir();
        scratch = writeTurnScratch(state.turns, parsed);
        seedGeneration = seedTurnConfig(configSeedDir, scratch.configDir);
      } catch (error) {
        gate.release();
        removeScratch(scratch?.root);
        const detail = error instanceof Error ? error.message : 'failed to stage turn files';
        return jsonError(503, 'cli_error', trimErrorMessage(detail, token));
      }

      const env = buildCursorAgentChildEnv({
        proxyUrl,
        stateDir: state.root,
        token,
        turnRoot: scratch.root,
      });

      let child: ChildProcessWithoutNullStreams;
      const spawnedAt = Date.now();
      try {
        child = spawnCursor(buildTurnArgv(parsed, scratch), { cwd: scratch.root, env });
      } catch (error) {
        gate.release();
        removeScratch(scratch.root);
        const detail = error instanceof Error ? error.message : 'failed to start';
        return jsonError(
          503,
          'cli_unavailable',
          `Cursor Agent CLI was not found: failed to start (${trimErrorMessage(detail, token)}).`,
        );
      }

      let released = false;
      const onFinally = () => {
        if (!released) {
          released = true;
          gate.release();
        }
        copyTurnConfigSeedBack(scratch.configDir, configSeedDir, seedGeneration);
        removeScratch(scratch.root);
      };

      const stream = relayCliStream({
        child,
        onFinally,
        signal: request.signal,
        spawnedAt,
        timeoutMs: turnTimeoutMs,
        token,
      });
      return new Response(stream, {
        headers: { 'content-type': 'text/event-stream' },
        status: 200,
      });
    }

    return jsonError(404, 'not_found', 'unknown Cursor Agent endpoint');
  };

  return cursorFetch as typeof fetch;
};

/**
 * Cursor Agent fetch keyed by outlet `proxyUrl` (LRU 4). CLI resolution happens
 * on the FIRST REQUEST, not at import time, so a deployment without the CLI
 * still boots and only this provider reports itself unavailable.
 */
export const getCursorAgentFetch = (proxyUrl?: string | null): typeof fetch => {
  const key = proxyUrl ?? '';
  const existing = keyed.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.fetch;
  }
  while (keyed.size >= FETCH_CACHE_MAX) {
    let oldestKey: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [entryKey, value] of keyed) {
      if (value.lastUsed < oldestAt) {
        oldestAt = value.lastUsed;
        oldestKey = entryKey;
      }
    }
    if (oldestKey !== undefined) keyed.delete(oldestKey);
    else break;
  }
  const impl = createCursorAgentFetch(proxyUrl ? { proxyUrl } : {});
  keyed.set(key, { fetch: impl, lastUsed: Date.now() });
  return impl;
};

/** Drop cached transports whose key is not in `keep` (empty string = no-proxy transport). */
export const evictCursorAgentFetchExcept = (keep: ReadonlySet<string>): void => {
  for (const key of keyed.keys()) {
    if (key && !keep.has(key)) keyed.delete(key);
  }
};

/** Test seam only. */
export const resetCursorAgentFetch = (): void => {
  keyed.clear();
};
