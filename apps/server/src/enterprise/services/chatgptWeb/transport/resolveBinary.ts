import { accessSync, constants } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';

import { ChatGPTWebTransportUnavailableError } from './errors';

/** Plain environment map: `NodeJS.ProcessEnv` is augmented with required app keys here. */
export type TransportEnvironment = Record<string, string | undefined>;

/** Explicit override; always wins so an operator can pin a vetted build. */
export const CURL_IMPERSONATE_BIN_ENV = 'CHATGPT_WEB_CURL_IMPERSONATE_BIN';

const BINARY_NAME = 'curl-impersonate';

/** Docker image location — the base stage extracts the static musl build here. */
const DOCKER_BINARY_PATH = `/usr/local/bin/${BINARY_NAME}`;

/** Dev location, filled by `bun run curl-impersonate:install`. */
const REPO_CACHE_SUFFIX = join('.cache', BINARY_NAME, BINARY_NAME);

/** How far up from cwd to look for the repo-local cache (monorepo package cwd). */
const REPO_LOOKUP_DEPTH = 6;

export const CURL_IMPERSONATE_MISSING_MESSAGE = [
  'ChatGPT Web transport unavailable: the curl-impersonate binary was not found.',
  'Run `bun run curl-impersonate:install` for local development,',
  `or set ${CURL_IMPERSONATE_BIN_ENV} to an absolute path.`,
].join(' ');

const isExecutable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const lookupOnPath = (env: TransportEnvironment): string | undefined => {
  const path = env.PATH;
  if (!path) return undefined;

  for (const entry of path.split(delimiter)) {
    if (!entry) continue;
    const candidate = join(entry, BINARY_NAME);
    if (isExecutable(candidate)) return candidate;
  }

  return undefined;
};

const lookupRepoCache = (cwd: string): string | undefined => {
  let current = resolve(cwd);

  for (let depth = 0; depth < REPO_LOOKUP_DEPTH; depth += 1) {
    const candidate = join(current, REPO_CACHE_SUFFIX);
    if (isExecutable(candidate)) return candidate;

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return undefined;
};

export interface ResolveCurlImpersonateBinaryOptions {
  cwd?: string;
  env?: TransportEnvironment;
  /** Explicit path from the transport options; checked before the environment. */
  override?: string;
}

/**
 * Resolution order: explicit option → env override → PATH → repo `.cache` → Docker path.
 * Throws {@link ChatGPTWebTransportUnavailableError} (never crashes at import time).
 */
export const resolveCurlImpersonateBinary = (
  options: ResolveCurlImpersonateBinaryOptions = {},
): string => {
  const env = options.env ?? process.env;
  const explicit = options.override || env[CURL_IMPERSONATE_BIN_ENV];

  if (explicit) {
    if (isExecutable(explicit)) return explicit;
    throw new ChatGPTWebTransportUnavailableError(
      `ChatGPT Web transport unavailable: ${CURL_IMPERSONATE_BIN_ENV} does not point at an executable file.`,
    );
  }

  const resolved =
    lookupOnPath(env) ??
    lookupRepoCache(options.cwd ?? process.cwd()) ??
    (isExecutable(DOCKER_BINARY_PATH) ? DOCKER_BINARY_PATH : undefined);

  if (!resolved) throw new ChatGPTWebTransportUnavailableError(CURL_IMPERSONATE_MISSING_MESSAGE);

  return resolved;
};

let cached: string | undefined;

/** Memoized resolution — the binary location cannot change while the process runs. */
export const resolveCurlImpersonateBinaryCached = (
  options: ResolveCurlImpersonateBinaryOptions = {},
): string => {
  if (cached) return cached;
  cached = resolveCurlImpersonateBinary(options);
  return cached;
};

/** Test seam only. */
export const resetCurlImpersonateBinaryCache = (): void => {
  cached = undefined;
};
