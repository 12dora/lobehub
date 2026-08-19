import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

import { CursorAgentUnavailableError } from './errors';
import { resolveCursorCliCached } from './resolveCli';
import { createAbortError, jsonError } from './transport.gate';
import {
  appendBounded,
  appendDiagnostic,
  killChild,
  looksLikeAuthFailure,
  trimErrorMessage,
} from './transport.relay';

export interface CursorAgentModel {
  id: string;
  name: string;
}

const MODELS_TTL_MS = 10 * 60 * 1000;
const SUFFIX_RE = / \((?:current|default)\)$/i;

const cache = new Map<string, { expiresAt: number; models: CursorAgentModel[] }>();

export const tokenCacheKey = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/**
 * Parse `cursor-agent --list-models` stdout. Lines look like
 * `composer-2.5 - Composer 2.5` or `auto - Auto (default)`.
 */
export const parseCursorModelList = (text: string): CursorAgentModel[] => {
  const models: CursorAgentModel[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const separator = line.indexOf(' - ');
    if (separator <= 0) continue;
    const id = line.slice(0, separator);
    if (!id || id.includes(' ') || id.includes('\t')) continue;
    const name = line.slice(separator + 3).replace(SUFFIX_RE, '');
    if (!name) continue;
    models.push({ id, name });
  }
  return models;
};

export const getCachedCursorModels = (
  token: string,
  now = Date.now(),
): CursorAgentModel[] | undefined => {
  const key = tokenCacheKey(token);
  const entry = cache.get(key);
  if (!entry || entry.expiresAt <= now) {
    if (entry) cache.delete(key);
    return undefined;
  }
  return entry.models;
};

export const setCachedCursorModels = (
  token: string,
  models: CursorAgentModel[],
  now = Date.now(),
): void => {
  cache.set(tokenCacheKey(token), { expiresAt: now + MODELS_TTL_MS, models });
};

/** Test seam only. */
export const resetCursorModelsCache = (): void => {
  cache.clear();
};

const MAX_MODELS_STDOUT_CHARS = 1_000_000;

/**
 * The caller owns the gate: it must be acquired BEFORE the scratch dir and the config
 * seed are staged, so a request that is going to be rejected as overloaded never writes
 * to the shared seed (and never copies a stale snapshot back over a fresher one).
 *
 * The models cache is re-read here because the caller checked it before waiting in the
 * queue: a concurrent turn may have filled it while this one was queued, and answering
 * from the cache is cheaper than spawning the CLI again.
 */
export const runListModels = async (params: {
  cwd: string;
  env: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs: number;
  token: string;
}): Promise<Response> => {
  const cached = getCachedCursorModels(params.token);
  if (cached) {
    return new Response(JSON.stringify({ models: cached }), {
      headers: { 'content-type': 'application/json' },
      status: 200,
    });
  }

  let child: ChildProcessWithoutNullStreams;
  try {
    const resolved = resolveCursorCliCached();
    child = spawn(resolved.command, [...resolved.args, '--list-models'], {
      cwd: params.cwd,
      // The child env is intentionally a clean allowlist, not the process env; the
      // ProcessEnv augmentation only describes what THIS process expects.
      env: params.env as NodeJS.ProcessEnv,
      stdio: 'pipe',
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'failed to start';
    throw new CursorAgentUnavailableError(
      `Cursor Agent CLI was not found: failed to start (${trimErrorMessage(detail, params.token)}).`,
    );
  }

  const stdout = { text: '' };
  const stderr = { text: '' };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => appendBounded(stdout, chunk, MAX_MODELS_STDOUT_CHARS));
  child.stderr.on('data', (chunk: string) => appendDiagnostic(stderr, chunk));
  child.stdin.on('error', () => undefined);
  child.stdin.end();

  const abort = () => killChild(child);
  params.signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, params.timeoutMs);
  timeout.unref?.();

  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on('error', (error) => reject(error));
      child.on('close', (exitCode) => resolve(exitCode));
    });
    if (params.signal?.aborted) throw createAbortError();
    const combined = `${stdout.text}\n${stderr.text}`;
    if (code && code !== 0) {
      const message = trimErrorMessage(combined, params.token) || `CLI exited ${code}`;
      if (looksLikeAuthFailure(combined)) return jsonError(401, 'unauthorized', message);
      return jsonError(503, 'cli_error', message);
    }
    const models = parseCursorModelList(stdout.text);
    setCachedCursorModels(params.token, models);
    return new Response(JSON.stringify({ models }), {
      headers: { 'content-type': 'application/json' },
      status: 200,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    const detail = error instanceof Error ? error.message : 'CLI failed';
    return jsonError(503, 'cli_error', trimErrorMessage(detail, params.token));
  } finally {
    clearTimeout(timeout);
    params.signal?.removeEventListener('abort', abort);
  }
};
