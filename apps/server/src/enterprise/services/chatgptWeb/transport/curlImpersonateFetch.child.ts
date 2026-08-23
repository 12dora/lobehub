import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { registerBrowserSessionScopeDrain } from '../../browserSession/transportPool';
import { redactSecrets } from '../../networkProxy/redact';
import { removeQuietly } from './bodyFile';
import { createBodyStream } from './bodyStream';
import { fetchFailed, MAX_STDERR_BYTES } from './curlConfig';
import { buildResponse } from './curlResponse';
import { ChatGPTWebTransportUnavailableError } from './errors';
import { HeaderDumpReader, type HeaderDumpSplit } from './headerDump';
import { createAbortError } from './request';

const KILL_GRACE_MS = 2000;
/**
 * A caller that takes the `Response` and never reads (or cancels) its body leaves curl
 * blocked on a full pipe for the whole `--max-time` budget. One wedged SSE stream is a
 * leaked child process plus a leaked upstream connection, so an unread body is killed.
 */
export const BODY_STALL_TIMEOUT_MS = 60_000;

interface TrackedCurlChild {
  close: Promise<void>;
  kill: () => void;
  scopes: Set<string>;
}

const trackedCurlChildren = new Set<TrackedCurlChild>();

const awaitChildCloses = async (victims: TrackedCurlChild[]): Promise<void> => {
  const results = await Promise.allSettled(
    victims.map((child) => Promise.resolve().then(() => child.close)),
  );
  const rejected = results.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (rejected.length === 0) return;
  const detail = rejected
    .map((result) => (result.reason instanceof Error ? result.reason.message : 'UnknownError'))
    .join('; ');
  throw new AggregateError(
    rejected.map((result) => result.reason),
    `curl-impersonate child drain failed: ${detail}`,
  );
};

export const drainCurlImpersonateChildren = async (scope: string): Promise<void> => {
  const victims = [...trackedCurlChildren].filter((child) => child.scopes.has(scope));
  for (const child of victims) child.kill();
  await awaitChildCloses(victims);
};

export const drainAllCurlImpersonateChildren = async (): Promise<void> => {
  const victims = [...trackedCurlChildren];
  for (const child of victims) child.kill();
  await awaitChildCloses(victims);
};

export const trackedCurlChildCountForTests = (): number => trackedCurlChildren.size;

registerBrowserSessionScopeDrain(drainCurlImpersonateChildren, drainAllCurlImpersonateChildren);

export const createCurlChildKiller = (
  child: ChildProcessWithoutNullStreams,
): { clearKillTimer: () => void; kill: () => void } => {
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
  const clearKillTimer = () => {
    if (killTimer) clearTimeout(killTimer);
  };
  return { clearKillTimer, kill };
};

const trackCurlChild = (
  child: ChildProcessWithoutNullStreams,
  kill: () => void,
  scopes: Set<string>,
): void => {
  const close = new Promise<void>((resolve) => {
    child.once('close', () => resolve());
  });
  const tracked: TrackedCurlChild = { close, kill, scopes };
  trackedCurlChildren.add(tracked);
  void close.finally(() => {
    trackedCurlChildren.delete(tracked);
  });
};

export const collectCurlChildScopes = (
  cookieJarPath: string | undefined,
  cookieJarKey: string | undefined,
  poolKey: string | undefined,
): Set<string> => {
  const scopes = new Set<string>();
  if (cookieJarPath) scopes.add(cookieJarPath);
  if (cookieJarKey) {
    scopes.add(cookieJarKey);
    if (poolKey) scopes.add(poolKey);
  }
  return scopes;
};

const pushStdoutChunk = (
  headerReader: HeaderDumpReader,
  chunk: Buffer,
  settleError: ((error: unknown) => void) | undefined,
  body: ReturnType<typeof createBodyStream>,
  kill: () => void,
  onHead: (split: HeaderDumpSplit) => void,
): void => {
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
  onHead(split);
  if (split.body.byteLength > 0) body.push(split.body);
};

/**
 * Wire stdout/stderr/close/abort after spawn. Listener order is load-bearing:
 * header dump shares stdout with the body, abort must detach, stdin is closed
 * only after listeners are attached so a fast child cannot miss `error`.
 */
export const awaitCurlChildResponse = (params: {
  bodyStallTimeoutMs: number;
  child: ChildProcessWithoutNullStreams;
  clearKillTimer: () => void;
  cookieJarKey?: string;
  cookieJarPath?: string;
  invocationConfig: string;
  kill: () => void;
  poolKey?: string;
  signal?: AbortSignal;
  tempBodyPath?: string;
  url: string;
}): Promise<Response> => {
  const { child, kill } = params;
  let tempBodyRemoved = false;
  const removeTempBody = () => {
    if (tempBodyRemoved) return;
    tempBodyRemoved = true;
    removeQuietly(params.tempBodyPath);
  };

  trackCurlChild(
    child,
    kill,
    collectCurlChildScopes(params.cookieJarPath, params.cookieJarKey, params.poolKey),
  );

  const body = createBodyStream({
    kill,
    stallTimeoutMs: params.bodyStallTimeoutMs,
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
    pushStdoutChunk(headerReader, chunk, settleError, body, kill, (split) => {
      if (!responded) {
        responded = true;
        settleResponse?.(buildResponse(split.head, body.stream, params.url));
      }
    });
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
  const detachAbort = () => params.signal?.removeEventListener('abort', onAbort);

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
    params.clearKillTimer();
    if (code === 0) {
      if (!headerReader.head) {
        settleError?.(fetchFailed(code, 'no response headers were received'));
      }
      body.finish();
      return;
    }

    const failure = fetchFailed(code, redactSecrets(stderr));
    // Before the head: a network-style rejection, exactly like undici.
    // After it: the caller already has a Response, so the failure belongs on the body.
    settleError?.(failure);
    body.fail(failure);
  });

  params.signal?.addEventListener('abort', onAbort, { once: true });

  // `--config -` reads stdin to EOF before the connection is opened, so the whole
  // (small) config is written up-front and the pipe is closed with it — otherwise curl
  // would wait for more config forever. The request body is NOT here: it is on disk,
  // referenced by `data-binary = "@…"` inside this config.
  child.stdin.on('error', () => undefined);
  child.stdin.end(params.invocationConfig);

  return responsePromise;
};
