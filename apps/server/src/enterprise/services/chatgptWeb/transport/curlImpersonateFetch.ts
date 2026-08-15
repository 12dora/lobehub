import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

import { ChatGPTWebTransportPolicyError, ChatGPTWebTransportUnavailableError } from './errors';
import { HeaderDumpReader, type HeaderDumpSplit, type ParsedHeaderBlock } from './headerDump';
import { createAbortError, hasControlCharacters, normalizeRequest } from './request';
import {
  resolveCurlImpersonateBinary,
  resolveCurlImpersonateBinaryCached,
  type TransportEnvironment,
} from './resolveBinary';

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

/** Verified against chatgpt.com: `chrome145` is challenged, `chrome136` is not. */
export const DEFAULT_IMPERSONATE_PROFILE = 'chrome136';

/** Chat streams run long; the per-request cap only guards a wedged connection. */
const DEFAULT_TIMEOUT_MS = 600_000;
const CONNECT_TIMEOUT_SECONDS = 20;
/** Enough for a curl diagnostic; never large enough to hold a response body. */
const MAX_STDERR_BYTES = 8192;
const KILL_GRACE_MS = 2000;
/**
 * A caller that takes the `Response` and never reads (or cancels) its body leaves curl
 * blocked on a full pipe for the whole `--max-time` budget. One wedged SSE stream is a
 * leaked child process plus a leaked upstream connection, so an unread body is killed.
 */
const BODY_STALL_TIMEOUT_MS = 60_000;

/** Statuses whose response is defined to have no body (Response would throw). */
const NULL_BODY_STATUS = new Set([204, 205, 304]);

/** Owner-only directory under the system temp dir holding in-flight request bodies. */
const TEMP_BODY_DIR = 'aihub-chatgptweb';

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

const fetchFailed = (code: number | null, stderr: string): TypeError => {
  const detail = stderr.trim().slice(0, 500);
  return new TypeError(`fetch failed: curl(${code ?? 'signal'})${detail ? `: ${detail}` : ''}`);
};

interface CurlInvocation {
  args: string[];
  config: string;
}

/**
 * curl config-file quoting (`docs/cmdline-opts` "config file"): a quoted parameter takes
 * `\\`, `\"`, `\t`, `\n`, `\r`, `\v` escapes. Everything else is literal.
 */
const quoteConfigValue = (value: string): string =>
  `"${value
    .replaceAll('\\', String.raw`\\`)
    .replaceAll('"', String.raw`\"`)
    .replaceAll('\t', String.raw`\t`)}"`;

const assertConfigSafe = (label: string, value: string): string => {
  if (hasControlCharacters(value.replaceAll('\t', ''))) {
    throw new ChatGPTWebTransportPolicyError(`${label} contains control characters`);
  }
  return value;
};

/**
 * Split the invocation into ARGV (non-secret constants only) and a CONFIG FILE handed to
 * the child on STDIN as `--config -`.
 *
 * Everything credential-bearing lives in the config: the URL (signed download links carry
 * their signature in the query), the proxy (may embed user:password) and every header
 * (`Authorization: Bearer …`). argv is world-readable through `ps` / `/proc/<pid>/cmdline`
 * and is copied into crash reports and process telemetry; a pipe is readable only by the
 * two processes that hold it.
 *
 * Why stdin and not an extra inherited fd: libuv's `spawn` gives extra `pipe` fds as UNIX
 * SOCKETPAIRS, and on Linux `fopen("/dev/fd/N")` on a socket fails with ENXIO — so
 * `--config /dev/fd/4` died with `curl: cannot read config from '/dev/fd/4'` (exit 26) in
 * every container. It only ever worked on macOS, whose fdesc filesystem re-opens sockets.
 * stdin is a pipe curl opens by descriptor, so it works on both.
 */
const buildInvocation = (params: {
  bodyFilePath?: string;
  caBundle?: string;
  headers: [string, string][];
  impersonate: string;
  method: string;
  proxyUrl?: string;
  timeoutMs: number;
  url: string;
}): CurlInvocation => {
  const args = [
    // MUST be argv[0]: curl reads `$CURL_HOME/.curlrc` (then XDG_CONFIG_HOME / HOME)
    // BEFORE any other option unless `--disable` is the very first argument. A host config
    // owned by whoever runs the server could turn on `location` (redirects — the hostname
    // allowlist only validates the FIRST url, so a redirect would carry the `Authorization`
    // header to an unvalidated destination), add a second `url`, or `output` the body to a
    // file. Passing it later is not equivalent: by then the file has already been parsed.
    '--disable',
    '--impersonate',
    params.impersonate,
    '--compressed',
    '--no-buffer',
    '--silent',
    '--show-error',
    '--http2',
    '--max-time',
    String(Math.max(1, Math.ceil(params.timeoutMs / 1000))),
    '--connect-timeout',
    String(CONNECT_TIMEOUT_SECONDS),
    // Headers first on STDOUT, body after: curl writes the dump before any body byte, so
    // the two are split by position, not by descriptor (see the note above on /dev/fd).
    '--dump-header',
    '-',
    // Secret-bearing options on stdin, never on the command line.
    '--config',
    '-',
  ];

  if (params.proxyUrl) args.push('--suppress-connect-headers');

  const lines = [
    `url = ${quoteConfigValue(assertConfigSafe('url', params.url))}`,
    `request = ${quoteConfigValue(assertConfigSafe('method', params.method))}`,
  ];
  if (params.proxyUrl) {
    lines.push(`proxy = ${quoteConfigValue(assertConfigSafe('proxy', params.proxyUrl))}`);
  }
  if (params.caBundle) {
    lines.push(`cacert = ${quoteConfigValue(assertConfigSafe('cacert', params.caBundle))}`);
  }
  // Only when there IS a body: `data-binary` alone would turn a GET into a zero-length
  // entity request with a form content-type. stdin is taken by the config, so the bytes
  // travel through an owner-only temp file that is unlinked as soon as curl exits.
  if (params.bodyFilePath) {
    lines.push(
      `data-binary = ${quoteConfigValue(assertConfigSafe('body file', `@${params.bodyFilePath}`))}`,
    );
  }
  for (const [name, value] of params.headers) {
    // curl reads `Name:` as "drop this header"; `Name;` sends it with an empty value.
    const header = value.length === 0 ? `${name};` : `${name}: ${value}`;
    lines.push(`header = ${quoteConfigValue(assertConfigSafe('header', header))}`);
  }

  return { args, config: `${lines.join('\n')}\n` };
};

const readEnv = (options: CurlImpersonateFetchOptions, env: TransportEnvironment) => ({
  caBundle: options.caBundle || env.SSL_CERT_FILE || env.NODE_EXTRA_CA_CERTS || undefined,
  impersonate: options.impersonate || DEFAULT_IMPERSONATE_PROFILE,
  proxyUrl: options.proxyUrl || env.PROXY_URL || env.HTTPS_PROXY || env.https_proxy || undefined,
  timeoutMs: options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
});

/**
 * Stage the request body where curl can read it back with `data-binary = "@path"`.
 *
 * `0600` inside a `0700` directory, an unguessable name, and `wx` (fail if it exists, and
 * never follow a symlink) so a pre-planted entry in a shared `/tmp` cannot redirect the
 * write. The path is never logged and never appears in argv — only inside the config that
 * travels down the child's stdin pipe.
 */
const writeRequestBodyFile = (body: Uint8Array): string => {
  const directory = join(tmpdir(), TEMP_BODY_DIR);
  mkdirSync(directory, { mode: 0o700, recursive: true });
  const path = join(directory, randomBytes(16).toString('hex'));
  writeFileSync(path, body, { flag: 'wx', mode: 0o600 });
  return path;
};

const removeQuietly = (path: string | undefined): void => {
  if (!path) return;
  try {
    unlinkSync(path);
  } catch {
    // Already gone, or the directory was cleaned underneath us.
  }
};

/**
 * Bridge the child's stdout to a web ReadableStream. The stream is closed ONLY on the
 * process `close` event, so a mid-stream curl failure (18 partial transfer, 56 recv
 * error) errors the body instead of being delivered as a clean, silently truncated
 * response.
 */
const createBodyStream = (params: {
  kill: () => void;
  stallTimeoutMs: number;
  stdout: Readable;
}): {
  fail: (error: unknown) => void;
  finish: () => void;
  push: (chunk: Uint8Array) => void;
  stream: ReadableStream<Uint8Array>;
} => {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let settled = false;
  let pendingError: unknown;
  let stallTimer: NodeJS.Timeout | undefined;

  const clearStall = () => {
    if (!stallTimer) return;
    clearTimeout(stallTimer);
    stallTimer = undefined;
  };

  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      settled = true;
      clearStall();
      params.kill();
    },
    pull() {
      clearStall();
      params.stdout.resume();
    },
    start(streamController) {
      controller = streamController;
    },
  });

  const fail = (error: unknown) => {
    pendingError = error;
    if (settled) return;
    settled = true;
    clearStall();
    try {
      controller?.error(error);
    } catch {
      // Stream already closed / cancelled by the consumer.
    }
  };

  const finish = () => {
    clearStall();
    if (settled) return;
    if (pendingError) {
      fail(pendingError);
      return;
    }
    settled = true;
    try {
      controller?.close();
    } catch {
      // Consumer cancelled first.
    }
  };

  /** Backpressure watchdog: nobody is reading, so nobody will ever resume the child. */
  const armStall = () => {
    if (stallTimer) return;
    stallTimer = setTimeout(() => {
      stallTimer = undefined;
      fail(
        new TypeError(
          'fetch failed: the ChatGPT Web transport response body was not consumed within 60s; the request was cancelled.',
        ),
      );
      params.kill();
    }, params.stallTimeoutMs);
    stallTimer.unref?.();
  };

  /**
   * Body bytes only: the caller splits the head off the shared stdout stream first, so
   * this never sees a header byte.
   */
  const push = (chunk: Uint8Array) => {
    if (settled) return;
    try {
      controller?.enqueue(chunk);
    } catch {
      settled = true;
      clearStall();
      return;
    }
    if (controller && controller.desiredSize !== null && controller.desiredSize <= 0) {
      params.stdout.pause();
      armStall();
    }
  };

  return { fail, finish, push, stream };
};

const attachUrl = (response: Response, url: string): Response => {
  try {
    Object.defineProperty(response, 'url', { configurable: true, value: url });
  } catch {
    // Some runtimes seal Response; the url is cosmetic for our consumers.
  }
  return response;
};

const buildResponse = (
  head: ParsedHeaderBlock,
  body: ReadableStream<Uint8Array> | null,
  url: string,
) =>
  attachUrl(
    new Response(NULL_BODY_STATUS.has(head.status) ? null : body, {
      headers: head.headers,
      status: head.status,
      statusText: head.statusText,
    }),
    url,
  );

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
