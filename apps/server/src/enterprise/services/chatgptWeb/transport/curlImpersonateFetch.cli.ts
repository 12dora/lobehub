import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';

import { removeQuietly, writeRequestBodyFile } from './bodyFile';
import { COOKIE_JAR_HEADER, getContextCookieJarPoolKey, stripCookieJarHeader } from './cookieJar';
import { buildInvocation, DEFAULT_IMPERSONATE_PROFILE, readEnv } from './curlConfig';
import {
  awaitCurlChildResponse,
  BODY_STALL_TIMEOUT_MS,
  createCurlChildKiller,
} from './curlImpersonateFetch.child';
import { resolveCliCookieJarPath } from './curlImpersonateFetch.jar';
import { ChatGPTWebTransportUnavailableError } from './errors';
import { createAbortError, normalizeRequest } from './request';
import { resolveCurlImpersonateBinary, resolveCurlImpersonateBinaryCached } from './resolveBinary';

/**
 * fetch-compatible transport backed by `curl-impersonate`.
 *
 * chatgpt.com answers Node's own fetch with a Cloudflare bot challenge (403,
 * `cf-mitigated: challenge`) whatever headers are sent — the TLS/HTTP2 fingerprint is
 * what is being checked. Spawning a browser-fingerprinted curl is therefore not an
 * optimisation but the only way the provider works at all.
 *
 * Contract kept deliberately close to WHATWG fetch: a real `Response` with a streaming
 * body, `AbortSignal` support, no redirect following, and undici-shaped network errors.
 */

export { DEFAULT_IMPERSONATE_PROFILE };

export {
  drainAllCurlImpersonateChildren,
  drainCurlImpersonateChildren,
  trackedCurlChildCountForTests,
} from './curlImpersonateFetch.child';

export interface CurlImpersonateFetchOptions {
  /** Absolute path to the binary; overrides env + PATH discovery. */
  binaryPath?: string;
  /** How long an unread (back-pressured) response body may stall before the child is killed. */
  bodyStallTimeoutMs?: number;
  /** CA bundle passed as `--cacert`; falls back to SSL_CERT_FILE / NODE_EXTRA_CA_CERTS. */
  caBundle?: string;
  /**
   * Factory-level Netscape jar (`cookie` / `cookie-jar`). Per-request
   * `X-AIHub-Cookie-Jar` overrides this. A context digest maps to the
   * Browser Session Context jar; a legacy device id still maps to
   * `$TMPDIR/aihub-chatgptweb-jars/<sha256(deviceId)>.txt` and seeds `oai-did`.
   * The header is stripped before spawn and never forwarded.
   */
  cookieJarPath?: string;
  /** `--max-time` budget for a whole request/response. */
  defaultTimeoutMs?: number;
  /** curl-impersonate browser profile. */
  impersonate?: string;
  /** `-x` proxy; falls back to PROXY_URL / HTTPS_PROXY. */
  proxyUrl?: string;
}

export const createCurlImpersonateFetch = (
  options: CurlImpersonateFetchOptions = {},
): typeof fetch => {
  // Per-factory memo: an explicit `binaryPath` must not poison (or be poisoned by) the
  // shared, env-driven module cache.
  let resolvedBinary: string | undefined;

  const impersonateFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = await normalizeRequest(input, init);
    const settings = readEnv(options, process.env);
    resolvedBinary ??= options.binaryPath
      ? resolveCurlImpersonateBinary({ override: options.binaryPath })
      : resolveCurlImpersonateBinaryCached();
    const binary = resolvedBinary;

    if (request.signal?.aborted) throw createAbortError();

    // `X-AIHub-Cookie-Jar` is a private hop-by-hop header: map it to a jar and
    // drop it so curl never sends it upstream. A context-scoped key is a digest
    // (or path) and must NOT be written as `oai-did` — that cookie is the
    // ChatGPT device id, seeded when the context is acquired.
    const stripped = stripCookieJarHeader(request.headers);
    const cookieJarPath = resolveCliCookieJarPath(stripped.cookieJarKey, options.cookieJarPath);

    let tempBodyPath: string | undefined;
    if (request.body) {
      try {
        tempBodyPath = writeRequestBodyFile(request.body);
      } catch (error) {
        throw new ChatGPTWebTransportUnavailableError(
          `ChatGPT Web transport unavailable: the request body could not be staged (${(error as Error).message}).`,
        );
      }
    }

    const invocation = buildInvocation({
      ...(tempBodyPath ? { bodyFilePath: tempBodyPath } : {}),
      caBundle: settings.caBundle,
      ...(cookieJarPath ? { cookieJarPath } : {}),
      dropHeaders: request.dropHeaders.filter(
        (name) => name.toLowerCase() !== COOKIE_JAR_HEADER.toLowerCase(),
      ),
      headers: stripped.headers,
      impersonate: settings.impersonate,
      method: request.method,
      proxyUrl: settings.proxyUrl,
      timeoutMs: settings.timeoutMs,
      url: request.url,
    });

    let child: ChildProcessWithoutNullStreams;
    try {
      // stdin = curl config (us → child), stdout = header dump followed by the body.
      child = spawn(binary, invocation.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams;
    } catch (error) {
      removeQuietly(tempBodyPath);
      throw new ChatGPTWebTransportUnavailableError(
        `ChatGPT Web transport unavailable: failed to start curl-impersonate (${(error as Error).message}).`,
      );
    }

    const { clearKillTimer, kill } = createCurlChildKiller(child);
    const poolKey = stripped.cookieJarKey
      ? getContextCookieJarPoolKey(stripped.cookieJarKey)
      : undefined;

    return awaitCurlChildResponse({
      bodyStallTimeoutMs: options.bodyStallTimeoutMs ?? BODY_STALL_TIMEOUT_MS,
      child,
      clearKillTimer,
      ...(stripped.cookieJarKey ? { cookieJarKey: stripped.cookieJarKey } : {}),
      ...(cookieJarPath ? { cookieJarPath } : {}),
      invocationConfig: invocation.config,
      kill,
      ...(poolKey ? { poolKey } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
      ...(tempBodyPath ? { tempBodyPath } : {}),
      url: request.url,
    });
  };

  return impersonateFetch as typeof fetch;
};
