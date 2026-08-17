import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';

import { removeQuietly, writeRequestBodyFile } from './bodyFile';
import { createBodyStream } from './bodyStream';
import { buildInvocation, fetchFailed, MAX_STDERR_BYTES, readEnv } from './curlConfig';
import { buildResponse } from './curlResponse';
import { ChatGPTWebTransportUnavailableError } from './errors';
import { HeaderDumpReader, type HeaderDumpSplit } from './headerDump';
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

export { DEFAULT_IMPERSONATE_PROFILE } from './curlConfig';

const KILL_GRACE_MS = 2000;
/**
 * A caller that takes the `Response` and never reads (or cancels) its body leaves curl
 * blocked on a full pipe for the whole `--max-time` budget. One wedged SSE stream is a
 * leaked child process plus a leaked upstream connection, so an unread body is killed.
 */
const BODY_STALL_TIMEOUT_MS = 60_000;

export interface CurlImpersonateFetchOptions {
  /** Absolute path to the binary; overrides env + PATH discovery. */
  binaryPath?: string;
  /** How long an unread (back-pressured) response body may stall before the child is killed. */
  bodyStallTimeoutMs?: number;
  /** CA bundle passed as `--cacert`; falls back to SSL_CERT_FILE / NODE_EXTRA_CA_CERTS. */
  caBundle?: string;
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

    let tempBodyPath: string | undefined;
    let tempBodyRemoved = false;
    const removeTempBody = () => {
      if (tempBodyRemoved) return;
      tempBodyRemoved = true;
      removeQuietly(tempBodyPath);
    };

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
      headers: request.headers,
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
      removeTempBody();
      throw new ChatGPTWebTransportUnavailableError(
        `ChatGPT Web transport unavailable: failed to start curl-impersonate (${(error as Error).message}).`,
      );
    }

    let killed = false;
    let killTimer: NodeJS.Timeout | undefined;
    const kill = () => {
      if (killed) return;
      killed = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // Already gone.
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone.
        }
      }, KILL_GRACE_MS);
      killTimer.unref?.();
    };

    const body = createBodyStream({
      kill,
      stallTimeoutMs: options.bodyStallTimeoutMs ?? BODY_STALL_TIMEOUT_MS,
      stdout: child.stdout,
    });
    const headerReader = new HeaderDumpReader();

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      // Slice the chunk: a single oversized write must not blow past the bound.
      if (stderr.length >= MAX_STDERR_BYTES) return;
      stderr += chunk.slice(0, MAX_STDERR_BYTES - stderr.length);
    });

    let settleResponse: ((response: Response) => void) | undefined;
    let settleError: ((error: unknown) => void) | undefined;
    let responseSettled = false;
    const responsePromise = new Promise<Response>((resolve, reject) => {
      settleResponse = (response) => {
        if (responseSettled) return;
        responseSettled = true;
        resolve(response);
      };
      settleError = (error) => {
        if (responseSettled) return;
        responseSettled = true;
        reject(error);
      };
    });

    /**
     * stdout carries the header dump and then the body, so every chunk goes through the
     * splitter first. Body bytes routinely share the chunk that completes the head, and
     * the terminating blank line can straddle two chunks — both are the splitter's job.
     */
    let responded = false;
    child.stdout.on('data', (chunk: Buffer) => {
      let split: HeaderDumpSplit | undefined;
      try {
        split = headerReader.push(chunk);
      } catch (error) {
        // Only the header-size guard throws here.
        const failure = new TypeError(`fetch failed: ${(error as Error).message}`);
        settleError?.(failure);
        body.fail(failure);
        kill();
        return;
      }
      if (!split) return;
      if (!responded) {
        responded = true;
        settleResponse?.(buildResponse(split.head, body.stream, request.url));
      }
      if (split.body.byteLength > 0) body.push(split.body);
    });
    // stdout ending without a complete block is handled by the `close` handler below.
    child.stdout.on('error', () => undefined);

    /**
     * The abort listener is per-request but the signal usually is NOT (one controller can
     * cover a whole conversation). Without this removal every request would leave a
     * closure — child process, streams and all — attached to a long-lived signal.
     */
    const onAbort = () => {
      const abortError = createAbortError();
      settleError?.(abortError);
      body.fail(abortError);
      kill();
      // The child is on its way out and an unlinked file stays readable through the fd it
      // already holds, so the bytes never outlive the request even if SIGTERM is slow.
      removeTempBody();
    };
    const detachAbort = () => request.signal?.removeEventListener('abort', onAbort);

    child.on('error', (error) => {
      detachAbort();
      removeTempBody();
      // spawn failure surfaces here on some platforms (ENOENT after the sync call).
      const failure = new ChatGPTWebTransportUnavailableError(
        `ChatGPT Web transport unavailable: curl-impersonate could not run (${error.message}).`,
      );
      settleError?.(failure);
      body.fail(failure);
    });

    child.on('close', (code) => {
      detachAbort();
      removeTempBody();
      if (killTimer) clearTimeout(killTimer);
      if (code === 0) {
        if (!headerReader.head) {
          settleError?.(fetchFailed(code, 'no response headers were received'));
        }
        body.finish();
        return;
      }

      const failure = fetchFailed(code, stderr);
      // Before the head: a network-style rejection, exactly like undici.
      // After it: the caller already has a Response, so the failure belongs on the body.
      settleError?.(failure);
      body.fail(failure);
    });

    request.signal?.addEventListener('abort', onAbort, { once: true });

    // `--config -` reads stdin to EOF before the connection is opened, so the whole
    // (small) config is written up-front and the pipe is closed with it — otherwise curl
    // would wait for more config forever. The request body is NOT here: it is on disk,
    // referenced by `data-binary = "@…"` inside this config.
    child.stdin.on('error', () => undefined);
    child.stdin.end(invocation.config);

    return responsePromise;
  };

  return impersonateFetch as typeof fetch;
};

let singleton: typeof fetch | undefined;

/**
 * Process-wide impersonated fetch. Binary resolution happens on the FIRST REQUEST, not
 * at import time, so a deployment without the binary still boots and only the ChatGPT
 * Web provider reports itself unavailable.
 */
export const getChatGPTWebFetch = (): typeof fetch => {
  singleton ??= createCurlImpersonateFetch();
  return singleton;
};

/** Test seam only. */
export const resetChatGPTWebFetch = (): void => {
  singleton = undefined;
};
