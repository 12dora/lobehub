import debug from 'debug';

import { fetchFailed } from '../../chatgptWeb/transport/curlConfig';
import { createAbortError } from '../../chatgptWeb/transport/request';
import {
  CURLM_CALL_MULTI_PERFORM,
  CURLMOPT_PIPELINING,
  CURLPAUSE_CONT,
  CURLPIPE_MULTIPLEX,
  fetchFailedMulti,
  formatCurlmError,
  handleAddress,
  isCurlmOk,
  type LibcurlBindings,
} from './libcurlFfi';
import {
  clearStall,
  drainMessages,
  failRequest,
  finishDestroyPool,
  pollAsync,
  type Pool,
  type PoolCommand,
  wakeup,
} from './multiDriver.lifecycle';
import type { LibcurlMultiDriverOptions, LibcurlPoolIdentity } from './multiDriver.types';

const log = debug('lobe-server:browser-session:transport');

export const TRANSPORT_POOL_DRAINED = 'fetch failed: browser session transport pool drained';

export interface MultiDriverRuntime {
  bindings: LibcurlBindings;
  maxQueuedBytesHighWater: number;
  options: LibcurlMultiDriverOptions;
  pollEntered: number;
  pollExited: number;
  pools: Map<string, Pool>;
}

export const noteQueued = (runtime: MultiDriverRuntime, value: number): void => {
  if (value > runtime.maxQueuedBytesHighWater) runtime.maxQueuedBytesHighWater = value;
};

const failAllInflight = (bindings: LibcurlBindings, pool: Pool, error: unknown): void => {
  for (const req of pool.inflight.values()) failRequest(bindings, req, error);
};

const applyAddCommand = (
  bindings: LibcurlBindings,
  pool: Pool,
  command: Extract<PoolCommand, { type: 'add' }>,
): void => {
  if (pool.destroyed || command.req.cleaned) {
    failRequest(
      bindings,
      command.req,
      pool.destroyed ? new TypeError(TRANSPORT_POOL_DRAINED) : createAbortError(),
    );
    return;
  }
  const rc = bindings.curl_multi_add_handle(pool.multi, command.req.handle);
  if (rc !== 0) {
    failRequest(bindings, command.req, fetchFailedMulti(bindings, rc));
    return;
  }
  command.req.added = true;
  command.req.addr = handleAddress(command.req.handle);
  pool.inflight.set(command.req.addr, command.req);
};

const applyUnpauseCommand = (
  bindings: LibcurlBindings,
  command: Extract<PoolCommand, { type: 'unpause' }>,
): void => {
  const req = command.req;
  if (req.cleaned || !req.paused) return;
  clearStall(req);
  req.paused = false;
  const rc = bindings.curl_easy_pause(req.handle, CURLPAUSE_CONT);
  if (rc !== 0) {
    failRequest(bindings, req, fetchFailed(rc, bindings.curl_easy_strerror(rc) ?? ''));
  }
};

const applyCommands = (bindings: LibcurlBindings, pool: Pool): void => {
  const commands = pool.commands.splice(0);
  for (const command of commands) {
    if (command.type === 'add') {
      applyAddCommand(bindings, pool, command);
      continue;
    }
    if (command.type === 'unpause') {
      applyUnpauseCommand(bindings, command);
      continue;
    }
    if (command.type === 'abort') {
      failRequest(bindings, command.req, command.error);
      continue;
    }
    pool.destroyed = true;
    failAllInflight(bindings, pool, new TypeError(TRANSPORT_POOL_DRAINED));
  }
};

const failPool = (bindings: LibcurlBindings, pool: Pool, error: unknown): void => {
  pool.destroyed = true;
  failAllInflight(bindings, pool, error);
};

const destroyDestroyedPool = (runtime: MultiDriverRuntime, pool: Pool): void => {
  const error = new TypeError(TRANSPORT_POOL_DRAINED);
  failAllInflight(runtime.bindings, pool, error);
  finishDestroyPool(runtime.bindings, pool, runtime.pools);
};

export interface PoolController {
  drainPool: (pool: Pool) => Promise<void>;
  enqueue: (pool: Pool, command: PoolCommand) => void;
  ensureLoop: (pool: Pool) => void;
  getOrCreatePool: (identity: LibcurlPoolIdentity) => Pool;
}

export const createPoolController = (runtime: MultiDriverRuntime): PoolController => {
  const { bindings, options, pools } = runtime;

  const enqueue = (pool: Pool, command: PoolCommand): void => {
    pool.commands.push(command);
    wakeup(bindings, pool);
    ensureLoop(pool);
  };

  const ensureLoop = (pool: Pool): void => {
    if (pool.loopRunning) return;
    pool.loopRunning = true;
    void (async () => {
      try {
        while (!pool.multiCleaned) {
          applyCommands(bindings, pool);
          if (pool.destroyed) {
            destroyDestroyedPool(runtime, pool);
            return;
          }
          if (pool.inflight.size === 0 && pool.commands.length === 0) return;

          const running = [0];
          let performRc = bindings.curl_multi_perform(pool.multi, running);
          while (performRc === CURLM_CALL_MULTI_PERFORM) {
            drainMessages(bindings, pool);
            applyCommands(bindings, pool);
            if (pool.destroyed || (pool.inflight.size === 0 && pool.commands.length === 0)) break;
            performRc = bindings.curl_multi_perform(pool.multi, running);
          }
          if (performRc !== CURLM_CALL_MULTI_PERFORM && !isCurlmOk(performRc)) {
            failPool(bindings, pool, fetchFailedMulti(bindings, performRc));
            finishDestroyPool(bindings, pool, pools);
            return;
          }
          drainMessages(bindings, pool);
          applyCommands(bindings, pool);
          if (pool.destroyed) {
            destroyDestroyedPool(runtime, pool);
            return;
          }
          if (pool.inflight.size === 0 && pool.commands.length === 0) return;

          pool.polling = true;
          runtime.pollEntered += 1;
          options.onPoll?.('enter');
          let pollRc: number;
          try {
            pollRc = await pollAsync(bindings, pool);
          } finally {
            pool.polling = false;
            runtime.pollExited += 1;
            options.onPoll?.('exit');
          }
          if (!isCurlmOk(pollRc)) {
            failPool(bindings, pool, fetchFailedMulti(bindings, pollRc));
            finishDestroyPool(bindings, pool, pools);
            return;
          }
        }
      } catch (error) {
        log('libcurl multi loop failed: %s', (error as Error).message);
        failPool(bindings, pool, fetchFailedMulti(bindings, error));
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
    if (!multi) throw fetchFailedMulti(bindings, 0, 'curl_multi_init returned null');
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
      throw fetchFailedMulti(bindings, setRc);
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

  return { drainPool, enqueue, ensureLoop, getOrCreatePool };
};
