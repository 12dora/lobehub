import debug from 'debug';

import { fetchFailed } from '../../chatgptWeb/transport/curlConfig';
import { HeaderDumpReader } from '../../chatgptWeb/transport/headerDump';
import { createAbortError } from '../../chatgptWeb/transport/request';
import type { CookieRecord } from '../cookieJar';
import { readBrowserCookieJar } from '../cookieJar';
import { createBodyBridge } from './bodyBridge';
import { applyEasyOptions, buildHeaderSlist } from './easyOptions';
import {
  CURL_WRITEFUNC_ERROR,
  CURL_WRITEFUNC_PAUSE,
  decodeBytes,
  registerWriteCallback,
  toByteCount,
  unregisterCallback,
} from './libcurlFfi';
import type { InFlight } from './multiDriver.lifecycle';
import { settleHead } from './multiDriver.lifecycle';
import type { MultiDriverRuntime, PoolController } from './multiDriver.loop';
import { noteQueued, TRANSPORT_POOL_DRAINED } from './multiDriver.loop';
import type { LibcurlPoolIdentity, LibcurlRequestInit } from './multiDriver.types';

const log = debug('lobe-server:browser-session:transport');

const DEFAULT_BODY_STALL_MS = 60_000;

const rollbackOrphanEasy = (
  bindings: MultiDriverRuntime['bindings'],
  handle: unknown,
  slist: unknown,
  writeCb: bigint | undefined,
  headerCb: bigint | undefined,
): void => {
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

const attachWriteCallback = (
  runtime: MultiDriverRuntime,
  controller: PoolController,
  req: InFlight,
): bigint => {
  const { bindings } = runtime;
  const pool = req.pool;
  return registerWriteCallback(bindings, (ptr, size, nmemb) => {
    try {
      if (req.cleaned) return 0;
      const n = toByteCount(size, nmemb);
      if (n <= 0) return 0;
      if (!req.headSettled) settleHead(req);
      const result = req.body.push(decodeBytes(ptr, n));
      noteQueued(runtime, req.body.maxQueuedBytes);
      if (result === 'pause') {
        req.paused = true;
        if (!req.stallTimer) {
          req.stallTimer = setTimeout(() => {
            req.stallTimer = undefined;
            controller.enqueue(pool, {
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
};

const attachHeaderCallback = (runtime: MultiDriverRuntime, req: InFlight): bigint =>
  registerWriteCallback(runtime.bindings, (ptr, size, nmemb) => {
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

export const submitLibcurlRequest = (
  runtime: MultiDriverRuntime,
  controller: PoolController,
  identity: LibcurlPoolIdentity,
  request: LibcurlRequestInit,
): Promise<Response> => {
  if (request.signal?.aborted) return Promise.reject(createAbortError());

  const pool = controller.getOrCreatePool(identity);
  if (pool.destroyed) return Promise.reject(new TypeError(TRANSPORT_POOL_DRAINED));

  let cookieSnapshot: CookieRecord[] = [];
  if (request.cookieJarPath) {
    cookieSnapshot = readBrowserCookieJar(request.cookieJarPath);
  }

  const { bindings } = runtime;
  const handle = bindings.curl_easy_init();
  if (!handle) return Promise.reject(new TypeError('fetch failed: curl_easy_init returned null'));

  let writeCb: bigint | undefined;
  let headerCb: bigint | undefined;
  let slist: unknown;

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
      onCancel: () => controller.enqueue(pool, { error: createAbortError(), req, type: 'abort' }),
      onPull: () => controller.enqueue(pool, { req, type: 'unpause' }),
    });

    try {
      writeCb = attachWriteCallback(runtime, controller, req);
      headerCb = attachHeaderCallback(runtime, req);
      req.writeCb = writeCb;
      req.headerCb = headerCb;

      const impersonateRc = bindings.curl_easy_impersonate(handle, request.impersonate, 1);
      if (impersonateRc !== 0) {
        throw fetchFailed(impersonateRc, bindings.curl_easy_strerror(impersonateRc) ?? '');
      }

      slist = buildHeaderSlist(bindings, request.headers, request.dropHeaders ?? []);
      req.slist = slist;
      applyEasyOptions(bindings, handle, request, slist, writeCb, headerCb);

      const onAbort = () =>
        controller.enqueue(pool, { error: createAbortError(), req, type: 'abort' });
      req.onAbort = onAbort;
      request.signal?.addEventListener('abort', onAbort, { once: true });
      if (request.signal?.aborted) {
        controller.enqueue(pool, { error: createAbortError(), req, type: 'abort' });
      } else {
        controller.enqueue(pool, { req, type: 'add' });
      }
    } catch (error) {
      rollbackOrphanEasy(bindings, handle, slist, writeCb, headerCb);
      reject(error);
    }
  });
};
