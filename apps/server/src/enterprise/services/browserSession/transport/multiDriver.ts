/**
 * In-process libcurl-impersonate multi driver.
 *
 * Thread confinement: while `curl_multi_poll.async` is outstanding on a pool's
 * CURLM, the ONLY native call allowed from outside the loop is
 * `curl_multi_wakeup`. `submit` / `abort` / `unpause` / `drain` only enqueue a
 * command and wake the loop. Adds, removes, pauses, and cleanups run after the
 * poll promise settles and before the next `curl_multi_perform`.
 *
 * One `CURLM` per pool key (browser context + origin + proxy outlet +
 * impersonation profile). Cookie state lives in the on-disk Netscape jar
 * (`COOKIEFILE` load + COOKIELIST delta merge). No CURLSH cookie share.
 */
import debug from 'debug';

import { fetchFailed } from '../../chatgptWeb/transport/curlConfig';
import { buildResponse } from '../../chatgptWeb/transport/curlResponse';
import { HeaderDumpReader } from '../../chatgptWeb/transport/headerDump';
import { createAbortError } from '../../chatgptWeb/transport/request';
import type { CookieRecord } from '../cookieJar';
import { readBrowserCookieJar } from '../cookieJar';
import { createBodyBridge } from './bodyBridge';
import { applyCookieListDelta } from './cookieDelta';
import { applyEasyOptions, buildHeaderSlist } from './easyOptions';
import {
  CURL_WRITEFUNC_ERROR,
  CURL_WRITEFUNC_PAUSE,
  CURLM_CALL_MULTI_PERFORM,
  CURLMOPT_PIPELINING,
  CURLMSG_DONE,
  CURLPAUSE_CONT,
  CURLPIPE_MULTIPLEX,
  decodeBytes,
  decodeCurlMsg,
  formatCurlmError,
  getLibcurlBindings,
  handleAddress,
  isCurlmOk,
  type KoffiPollCallback,
  type LibcurlBindings,
  MULTI_POLL_TIMEOUT_MS,
  readCookieSlist,
  registerWriteCallback,
  toByteCount,
  unregisterCallback,
} from './libcurlFfi';

const log = debug('lobe-server:browser-session:transport');

const DEFAULT_BODY_STALL_MS = 60_000;
const NULL_BODY_STATUS = new Set([204, 205, 304]);

export const TRANSPORT_POOL_DRAINED = 'fetch failed: browser session transport pool drained';

export interface LibcurlRequestInit {
  body?: Uint8Array;
  bodyStallTimeoutMs?: number;
  caBundle?: string;
  cookieJarPath?: string;
  dropHeaders?: string[];
  headers: [string, string][];
  impersonate: string;
  method: string;
  proxyUrl?: string;
  signal?: AbortSignal;
  timeoutMs: number;
  url: string;
}

export interface LibcurlPoolIdentity {
  key: string;
  origin: string;
  proxyOutlet: string;
  scope: string;
}

export interface LibcurlMultiDriverStats {
  bufferedBodyBytes: number;
  inFlight: number;
  maxQueuedBytes: number;
  paused: number;
  pollEntered: number;
  pollExited: number;
  polling: number;
  pools: number;
}

export interface LibcurlMultiDriverOptions {
  onPoll?: (phase: 'enter' | 'exit') => void;
}

export interface LibcurlMultiDriver {
  drain: (keyOrScope: string) => Promise<void>;
  drainAll: () => Promise<void>;
  drainWhere: (predicate: (pool: LibcurlPoolIdentity) => boolean) => Promise<void>;
  stats: () => LibcurlMultiDriverStats;
  submit: (pool: LibcurlPoolIdentity, request: LibcurlRequestInit) => Promise<Response>;
}

type PoolCommand =
  | { error: unknown; req: InFlight; type: 'abort' }
  | { req: InFlight; type: 'add' }
  | { type: 'drain' }
  | { req: InFlight; type: 'unpause' };

interface InFlight {
  added: boolean;
  addr: string;
  body: ReturnType<typeof createBodyBridge>;
  callbackError?: unknown;
  cleaned: boolean;
  cookieJarPath?: string;
  cookieSnapshot: CookieRecord[];
  handle: unknown;
  headerCb: bigint;
  headerReader: HeaderDumpReader;
  headSettled: boolean;
  leaked: boolean;
  onAbort?: () => void;
  paused: boolean;
  pool: Pool;
  reject: (error: unknown) => void;
  resolve: (response: Response) => void;
  signal?: AbortSignal;
  slist: unknown;
  stallTimeoutMs: number;
  stallTimer?: ReturnType<typeof setTimeout>;
  url: string;
  writeCb: bigint;
}

interface Pool extends LibcurlPoolIdentity {
  commands: PoolCommand[];
  destroyed: boolean;
  drainWaiters: Array<{ reject: (error: unknown) => void; resolve: () => void }>;
  inflight: Map<string, InFlight>;
  leaked: unknown[];
  loopRunning: boolean;
  multi: unknown;
  multiCleaned: boolean;
  polling: boolean;
}

const clearStall = (req: InFlight): void => {
  if (!req.stallTimer) return;
  clearTimeout(req.stallTimer);
  req.stallTimer = undefined;
};

const detachAbort = (req: InFlight): void => {
  if (req.signal && req.onAbort) req.signal.removeEventListener('abort', req.onAbort);
  req.onAbort = undefined;
};

const wakeup = (bindings: LibcurlBindings, pool: Pool): void => {
  if (pool.multiCleaned || !pool.multi) return;
  try {
    const rc = bindings.curl_multi_wakeup(pool.multi);
    if (rc !== 0) log('curl_multi_wakeup failed: %s', formatCurlmError(bindings, rc));
  } catch (error) {
    log('curl_multi_wakeup failed: %s', (error as Error).message);
  }
};

const persistCookies = (bindings: LibcurlBindings, req: InFlight): void => {
  if (!req.cookieJarPath || req.leaked) return;
  const list = readCookieSlist(bindings, req.handle);
  if (!list.ok) {
    log('CURLINFO_COOKIELIST failed code=%d; leaving disk jar untouched', list.code);
    return;
  }
  try {
    applyCookieListDelta({
      cookieJarPath: req.cookieJarPath,
      listLines: list.lines,
      snapshot: req.cookieSnapshot,
    });
  } catch (error) {
    log('cookie delta merge failed: %s', (error as Error).message);
  }
};

/**
 * Loop-thread only. On remove_handle failure: quarantine, do not cleanup or
 * unregister, and destroy the pool.
 */
const cleanupEasy = (bindings: LibcurlBindings, req: InFlight): void => {
  if (req.cleaned) return;
  req.cleaned = true;
  clearStall(req);
  detachAbort(req);

  if (req.added && req.pool.multi && !req.pool.multiCleaned) {
    const rc = bindings.curl_multi_remove_handle(req.pool.multi, req.handle);
    if (rc !== 0) {
      log('curl_multi_remove_handle failed: %s', formatCurlmError(bindings, rc));
      req.leaked = true;
      req.pool.leaked.push(req.handle);
      req.pool.inflight.delete(req.addr);
      req.pool.destroyed = true;
      return;
    }
    req.added = false;
  }

  try {
    bindings.curl_easy_cleanup(req.handle);
  } catch (error) {
    log('curl_easy_cleanup failed: %s', (error as Error).message);
  }
  if (req.slist) {
    try {
      bindings.curl_slist_free_all(req.slist);
    } catch (error) {
      log('curl_slist_free_all failed: %s', (error as Error).message);
    }
    req.slist = null;
  }
  try {
    unregisterCallback(req.writeCb);
  } catch (error) {
    log('unregister write callback failed: %s', (error as Error).message);
  }
  try {
    unregisterCallback(req.headerCb);
  } catch (error) {
    log('unregister header callback failed: %s', (error as Error).message);
  }
  req.pool.inflight.delete(req.addr);
};

const failRequest = (bindings: LibcurlBindings, req: InFlight, error: unknown): void => {
  if (req.headSettled) persistCookies(bindings, req);
  if (!req.headSettled) {
    req.reject(error);
    req.headSettled = true;
  }
  req.body.fail(error);
  cleanupEasy(bindings, req);
};

const settleHead = (req: InFlight): void => {
  if (req.headSettled) return;
  const head = req.headerReader.head;
  if (!head) return;
  req.headSettled = true;
  const stream = NULL_BODY_STATUS.has(head.status) ? null : req.body.stream;
  req.resolve(buildResponse(head, stream, req.url));
};

const finishDestroyPool = (
  bindings: LibcurlBindings,
  pool: Pool,
  pools: Map<string, Pool>,
): void => {
  if (pool.multiCleaned) {
    for (const waiter of pool.drainWaiters.splice(0)) waiter.resolve();
    return;
  }
  pool.multiCleaned = true;
  let cleanupError: unknown;
  try {
    const rc = bindings.curl_multi_cleanup(pool.multi);
    if (rc !== 0) {
      cleanupError = new Error(`curl_multi_cleanup failed: ${formatCurlmError(bindings, rc)}`);
      log('%s', (cleanupError as Error).message);
    }
  } catch (error) {
    cleanupError = error;
    log('curl_multi_cleanup failed: %s', (error as Error).message);
  }
  if (pools.get(pool.key) === pool) pools.delete(pool.key);
  for (const waiter of pool.drainWaiters.splice(0)) {
    if (cleanupError) waiter.reject(cleanupError);
    else waiter.resolve();
  }
};

const drainMessages = (bindings: LibcurlBindings, pool: Pool): void => {
  for (;;) {
    const queue = [0];
    const raw = bindings.curl_multi_info_read(pool.multi, queue);
    if (!raw) break;
    const msg = decodeCurlMsg(bindings, raw);
    if (msg.msg !== CURLMSG_DONE) continue;
    const req = pool.inflight.get(handleAddress(msg.easy_handle));
    if (!req) continue;
    const result = Number(msg.result);
    if (result !== 0) {
      const error =
        req.callbackError ??
        fetchFailed(
          result,
          (() => {
            try {
              return bindings.curl_easy_strerror(result) ?? '';
            } catch {
              return '';
            }
          })(),
        );
      failRequest(bindings, req, error);
      continue;
    }
    if (!req.headerReader.head) {
      failRequest(bindings, req, fetchFailed(0, 'no response headers were received'));
      continue;
    }
    persistCookies(bindings, req);
    settleHead(req);
    req.body.finish();
    cleanupEasy(bindings, req);
  }
};

const pollAsync = (bindings: LibcurlBindings, pool: Pool): Promise<number> =>
  new Promise((resolve, reject) => {
    const done: KoffiPollCallback = (error: Error | null, result: number) => {
      if (error) reject(error);
      else resolve(result);
    };
    try {
      bindings.curl_multi_poll.async(pool.multi, null, 0, MULTI_POLL_TIMEOUT_MS, [0], done);
    } catch (error) {
      reject(error);
    }
  });

export const createLibcurlMultiDriver = (
  options: LibcurlMultiDriverOptions = {},
): LibcurlMultiDriver => {
  const bindings = getLibcurlBindings();
  const pools = new Map<string, Pool>();
  let pollEntered = 0;
  let pollExited = 0;
  let maxQueuedBytesHighWater = 0;

  const noteQueued = (value: number): void => {
    if (value > maxQueuedBytesHighWater) maxQueuedBytesHighWater = value;
  };

  const enqueue = (pool: Pool, command: PoolCommand): void => {
    pool.commands.push(command);
    wakeup(bindings, pool);
    ensureLoop(pool);
  };

  const applyCommands = (pool: Pool): void => {
    const commands = pool.commands.splice(0);
    for (const command of commands) {
      if (command.type === 'add') {
        if (pool.destroyed || command.req.cleaned) {
          failRequest(
            bindings,
            command.req,
            pool.destroyed ? new TypeError(TRANSPORT_POOL_DRAINED) : createAbortError(),
          );
          continue;
        }
        const rc = bindings.curl_multi_add_handle(pool.multi, command.req.handle);
        if (rc !== 0) {
          failRequest(bindings, command.req, fetchFailed(rc, formatCurlmError(bindings, rc)));
          continue;
        }
        command.req.added = true;
        command.req.addr = handleAddress(command.req.handle);
        pool.inflight.set(command.req.addr, command.req);
        continue;
      }
      if (command.type === 'unpause') {
        const req = command.req;
        if (req.cleaned || !req.paused) continue;
        clearStall(req);
        req.paused = false;
        const rc = bindings.curl_easy_pause(req.handle, CURLPAUSE_CONT);
        if (rc !== 0) {
          failRequest(bindings, req, fetchFailed(rc, bindings.curl_easy_strerror(rc) ?? ''));
        }
        continue;
      }
      if (command.type === 'abort') {
        failRequest(bindings, command.req, command.error);
        continue;
      }
      pool.destroyed = true;
      const error = new TypeError(TRANSPORT_POOL_DRAINED);
      for (const req of pool.inflight.values()) failRequest(bindings, req, error);
    }
  };

  const failPool = (pool: Pool, error: unknown): void => {
    pool.destroyed = true;
    for (const req of pool.inflight.values()) failRequest(bindings, req, error);
  };

  const ensureLoop = (pool: Pool): void => {
    if (pool.loopRunning) return;
    pool.loopRunning = true;
    void (async () => {
      try {
        while (!pool.multiCleaned) {
          applyCommands(pool);
          if (pool.destroyed) {
            const error = new TypeError(TRANSPORT_POOL_DRAINED);
            for (const req of pool.inflight.values()) failRequest(bindings, req, error);
            finishDestroyPool(bindings, pool, pools);
            return;
          }
          if (pool.inflight.size === 0 && pool.commands.length === 0) return;

          const running = [0];
          let performRc = bindings.curl_multi_perform(pool.multi, running);
          while (performRc === CURLM_CALL_MULTI_PERFORM) {
            drainMessages(bindings, pool);
            applyCommands(pool);
            if (pool.destroyed || (pool.inflight.size === 0 && pool.commands.length === 0)) break;
            performRc = bindings.curl_multi_perform(pool.multi, running);
          }
          if (performRc !== CURLM_CALL_MULTI_PERFORM && !isCurlmOk(performRc)) {
            failPool(pool, new TypeError(`fetch failed: ${formatCurlmError(bindings, performRc)}`));
            finishDestroyPool(bindings, pool, pools);
            return;
          }
          drainMessages(bindings, pool);
          applyCommands(pool);
          if (pool.destroyed) {
            const error = new TypeError(TRANSPORT_POOL_DRAINED);
            for (const req of pool.inflight.values()) failRequest(bindings, req, error);
            finishDestroyPool(bindings, pool, pools);
            return;
          }
          if (pool.inflight.size === 0 && pool.commands.length === 0) return;

          pool.polling = true;
          pollEntered += 1;
          options.onPoll?.('enter');
          let pollRc: number;
          try {
            pollRc = await pollAsync(bindings, pool);
          } finally {
            pool.polling = false;
            pollExited += 1;
            options.onPoll?.('exit');
          }
          if (!isCurlmOk(pollRc)) {
            failPool(pool, new TypeError(`fetch failed: ${formatCurlmError(bindings, pollRc)}`));
            finishDestroyPool(bindings, pool, pools);
            return;
          }
        }
      } catch (error) {
        log('libcurl multi loop failed: %s', (error as Error).message);
        failPool(pool, error);
        finishDestroyPool(bindings, pool, pools);
      } finally {
        pool.loopRunning = false;
        if (pool.destroyed && !pool.multiCleaned) finishDestroyPool(bindings, pool, pools);
        else if (!pool.destroyed && (pool.inflight.size > 0 || pool.commands.length > 0)) {
          ensureLoop(pool);
        }
      }
    })();
  };

  const getOrCreatePool = (identity: LibcurlPoolIdentity): Pool => {
    const existing = pools.get(identity.key);
    if (existing && !existing.destroyed) return existing;

    const multi = bindings.curl_multi_init();
    if (!multi) throw new Error('curl_multi_init returned null');
    const setRc = bindings.curl_multi_setopt(
      multi,
      CURLMOPT_PIPELINING,
      'long',
      CURLPIPE_MULTIPLEX,
    );
    if (setRc !== 0) {
      const cleanupRc = bindings.curl_multi_cleanup(multi);
      if (cleanupRc !== 0) {
        log('curl_multi_cleanup after setopt failure: %s', formatCurlmError(bindings, cleanupRc));
      }
      throw new Error(`curl_multi_setopt failed: ${formatCurlmError(bindings, setRc)}`);
    }

    const pool: Pool = {
      commands: [],
      destroyed: false,
      drainWaiters: [],
      inflight: new Map(),
      key: identity.key,
      leaked: [],
      loopRunning: false,
      multi,
      multiCleaned: false,
      origin: identity.origin,
      polling: false,
      proxyOutlet: identity.proxyOutlet,
      scope: identity.scope,
    };
    pools.set(identity.key, pool);
    return pool;
  };

  const drainPool = (pool: Pool): Promise<void> => {
    if (pool.multiCleaned) return Promise.resolve();
    // Mark destroyed immediately so getOrCreatePool will not reuse this instance
    // while the loop is still applying the drain command after poll.
    pool.destroyed = true;
    return new Promise((resolve, reject) => {
      pool.drainWaiters.push({ reject, resolve });
      enqueue(pool, { type: 'drain' });
    });
  };

  const submit = (
    identity: LibcurlPoolIdentity,
    request: LibcurlRequestInit,
  ): Promise<Response> => {
    if (request.signal?.aborted) return Promise.reject(createAbortError());

    const pool = getOrCreatePool(identity);
    if (pool.destroyed) return Promise.reject(new TypeError(TRANSPORT_POOL_DRAINED));

    let cookieSnapshot: CookieRecord[] = [];
    if (request.cookieJarPath) {
      cookieSnapshot = readBrowserCookieJar(request.cookieJarPath);
    }

    const handle = bindings.curl_easy_init();
    if (!handle) return Promise.reject(new TypeError('fetch failed: curl_easy_init returned null'));

    let writeCb: bigint | undefined;
    let headerCb: bigint | undefined;
    let slist: unknown;

    const rollbackOrphan = (): void => {
      try {
        bindings.curl_easy_cleanup(handle);
      } catch {
        // Best-effort — handle was never added to the multi.
      }
      if (slist) {
        try {
          bindings.curl_slist_free_all(slist);
        } catch {
          // Best-effort.
        }
      }
      if (writeCb !== undefined) {
        try {
          unregisterCallback(writeCb);
        } catch {
          // Best-effort.
        }
      }
      if (headerCb !== undefined) {
        try {
          unregisterCallback(headerCb);
        } catch {
          // Best-effort.
        }
      }
    };

    return new Promise<Response>((resolve, reject) => {
      const req = {
        added: false,
        addr: '',
        body: undefined as unknown as ReturnType<typeof createBodyBridge>,
        cleaned: false,
        cookieSnapshot,
        handle,
        headerCb: 0n,
        headerReader: new HeaderDumpReader(),
        headSettled: false,
        leaked: false,
        paused: false,
        pool,
        reject,
        resolve,
        slist: null as unknown,
        stallTimeoutMs: request.bodyStallTimeoutMs ?? DEFAULT_BODY_STALL_MS,
        url: request.url,
        writeCb: 0n,
      } as InFlight;
      if (request.cookieJarPath) req.cookieJarPath = request.cookieJarPath;
      if (request.signal) req.signal = request.signal;

      req.body = createBodyBridge({
        onCancel: () => enqueue(pool, { error: createAbortError(), req, type: 'abort' }),
        onPull: () => enqueue(pool, { req, type: 'unpause' }),
      });

      try {
        writeCb = registerWriteCallback(bindings, (ptr, size, nmemb) => {
          try {
            if (req.cleaned) return 0;
            const n = toByteCount(size, nmemb);
            if (n <= 0) return 0;
            if (!req.headSettled) settleHead(req);
            const result = req.body.push(decodeBytes(ptr, n));
            noteQueued(req.body.maxQueuedBytes);
            if (result === 'pause') {
              req.paused = true;
              if (!req.stallTimer) {
                req.stallTimer = setTimeout(() => {
                  req.stallTimer = undefined;
                  enqueue(pool, {
                    error: new TypeError(
                      'fetch failed: the ChatGPT Web transport response body was not consumed within 60s; the request was cancelled.',
                    ),
                    req,
                    type: 'abort',
                  });
                }, req.stallTimeoutMs);
                req.stallTimer.unref?.();
              }
              return CURL_WRITEFUNC_PAUSE;
            }
            if (result === 'closed') return CURL_WRITEFUNC_ERROR;
            return n;
          } catch (error) {
            log('write callback failed: %s', (error as Error).message);
            return 0;
          }
        });
        headerCb = registerWriteCallback(bindings, (ptr, size, nmemb) => {
          try {
            if (req.cleaned) return 0;
            const n = toByteCount(size, nmemb);
            if (n <= 0) return 0;
            req.headerReader.push(decodeBytes(ptr, n));
            if (req.headerReader.head) settleHead(req);
            return n;
          } catch (error) {
            req.callbackError = new TypeError(`fetch failed: ${(error as Error).message}`);
            return 0;
          }
        });
        req.writeCb = writeCb;
        req.headerCb = headerCb;

        const impersonateRc = bindings.curl_easy_impersonate(handle, request.impersonate, 1);
        if (impersonateRc !== 0) {
          throw fetchFailed(impersonateRc, bindings.curl_easy_strerror(impersonateRc) ?? '');
        }

        slist = buildHeaderSlist(bindings, request.headers, request.dropHeaders ?? []);
        req.slist = slist;
        applyEasyOptions(bindings, handle, request, slist, writeCb, headerCb);

        const onAbort = () => enqueue(pool, { error: createAbortError(), req, type: 'abort' });
        req.onAbort = onAbort;
        request.signal?.addEventListener('abort', onAbort, { once: true });
        if (request.signal?.aborted) {
          enqueue(pool, { error: createAbortError(), req, type: 'abort' });
        } else {
          enqueue(pool, { req, type: 'add' });
        }
      } catch (error) {
        rollbackOrphan();
        reject(error);
      }
    });
  };

  const drain = async (keyOrScope: string): Promise<void> => {
    const targets = [...pools.values()].filter(
      (pool) => pool.key === keyOrScope || pool.scope === keyOrScope,
    );
    await Promise.all(targets.map((pool) => drainPool(pool)));
  };

  const drainWhere = async (predicate: (pool: LibcurlPoolIdentity) => boolean): Promise<void> => {
    await Promise.all(
      [...pools.values()].filter((pool) => predicate(pool)).map((pool) => drainPool(pool)),
    );
  };

  const drainAll = async (): Promise<void> => {
    await Promise.all([...pools.values()].map((pool) => drainPool(pool)));
  };

  const stats = (): LibcurlMultiDriverStats => {
    let inFlight = 0;
    let paused = 0;
    let bufferedBodyBytes = 0;
    let polling = 0;
    for (const pool of pools.values()) {
      inFlight += pool.inflight.size;
      if (pool.polling) polling += 1;
      for (const req of pool.inflight.values()) {
        if (req.paused) paused += 1;
        bufferedBodyBytes += req.body.bufferedBytes;
        noteQueued(req.body.maxQueuedBytes);
      }
    }
    return {
      bufferedBodyBytes,
      inFlight,
      maxQueuedBytes: maxQueuedBytesHighWater,
      paused,
      pollEntered,
      pollExited,
      polling,
      pools: pools.size,
    };
  };

  return { drain, drainAll, drainWhere, stats, submit };
};

let sharedDriver: LibcurlMultiDriver | undefined;

export const getSharedLibcurlMultiDriver = (): LibcurlMultiDriver => {
  sharedDriver ??= createLibcurlMultiDriver();
  return sharedDriver;
};

export const resetSharedLibcurlMultiDriverForTests = async (): Promise<void> => {
  await sharedDriver?.drainAll();
  sharedDriver = undefined;
};

export const drainSharedLibcurlPools = async (keyOrScope: string): Promise<void> => {
  if (!sharedDriver) return;
  await sharedDriver.drain(keyOrScope);
};

export const drainSharedLibcurlPoolsWhere = async (
  predicate: (pool: LibcurlPoolIdentity) => boolean,
): Promise<void> => {
  if (!sharedDriver) return;
  await sharedDriver.drainWhere(predicate);
};

export const drainAllSharedLibcurlPools = async (): Promise<void> => {
  if (!sharedDriver) return;
  await sharedDriver.drainAll();
};
