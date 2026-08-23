import debug from 'debug';

import { fetchFailed } from '../../chatgptWeb/transport/curlConfig';
import { buildResponse } from '../../chatgptWeb/transport/curlResponse';
import type { HeaderDumpReader } from '../../chatgptWeb/transport/headerDump';
import type { CookieRecord } from '../cookieJar';
import type { createBodyBridge } from './bodyBridge';
import { applyCookieListDelta } from './cookieDelta';
import {
  CURLMSG_DONE,
  decodeCurlMsg,
  formatCurlmError,
  handleAddress,
  type KoffiPollCallback,
  type LibcurlBindings,
  MULTI_POLL_TIMEOUT_MS,
  readCookieSlist,
  unregisterCallback,
} from './libcurlFfi';
import type { LibcurlPoolIdentity } from './multiDriver.types';

const log = debug('lobe-server:browser-session:transport');

export const NULL_BODY_STATUS = new Set([204, 205, 304]);

export type PoolCommand =
  | { error: unknown; req: InFlight; type: 'abort' }
  | { req: InFlight; type: 'add' }
  | { type: 'drain' }
  | { req: InFlight; type: 'unpause' };

export interface InFlight {
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

export interface Pool extends LibcurlPoolIdentity {
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

export const clearStall = (req: InFlight): void => {
  if (!req.stallTimer) return;
  clearTimeout(req.stallTimer);
  req.stallTimer = undefined;
};

export const detachAbort = (req: InFlight): void => {
  if (req.signal && req.onAbort) req.signal.removeEventListener('abort', req.onAbort);
  req.onAbort = undefined;
};

export const wakeup = (bindings: LibcurlBindings, pool: Pool): void => {
  if (pool.multiCleaned || !pool.multi) return;
  try {
    const rc = bindings.curl_multi_wakeup(pool.multi);
    if (rc !== 0) log('curl_multi_wakeup failed: %s', formatCurlmError(bindings, rc));
  } catch (error) {
    log('curl_multi_wakeup failed: %s', (error as Error).message);
  }
};

export const persistCookies = (bindings: LibcurlBindings, req: InFlight): void => {
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
export const cleanupEasy = (bindings: LibcurlBindings, req: InFlight): void => {
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

export const failRequest = (bindings: LibcurlBindings, req: InFlight, error: unknown): void => {
  if (req.headSettled) persistCookies(bindings, req);
  if (!req.headSettled) {
    req.reject(error);
    req.headSettled = true;
  }
  req.body.fail(error);
  cleanupEasy(bindings, req);
};

export const settleHead = (req: InFlight): void => {
  if (req.headSettled) return;
  const head = req.headerReader.head;
  if (!head) return;
  req.headSettled = true;
  const stream = NULL_BODY_STATUS.has(head.status) ? null : req.body.stream;
  req.resolve(buildResponse(head, stream, req.url));
};

export const finishDestroyPool = (
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

export const drainMessages = (bindings: LibcurlBindings, pool: Pool): void => {
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

export const pollAsync = (bindings: LibcurlBindings, pool: Pool): Promise<number> =>
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
