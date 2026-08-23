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
import { getLibcurlBindings } from './libcurlFfi';
import type { Pool } from './multiDriver.lifecycle';
import { createPoolController, type MultiDriverRuntime, noteQueued } from './multiDriver.loop';
import { submitLibcurlRequest } from './multiDriver.submit';
import type {
  LibcurlMultiDriver,
  LibcurlMultiDriverOptions,
  LibcurlMultiDriverStats,
  LibcurlPoolIdentity,
  LibcurlRequestInit,
} from './multiDriver.types';

export { TRANSPORT_POOL_DRAINED } from './multiDriver.loop';
export type {
  LibcurlMultiDriver,
  LibcurlMultiDriverOptions,
  LibcurlMultiDriverStats,
  LibcurlPoolIdentity,
  LibcurlRequestInit,
} from './multiDriver.types';

export const createLibcurlMultiDriver = (
  options: LibcurlMultiDriverOptions = {},
): LibcurlMultiDriver => {
  const runtime: MultiDriverRuntime = {
    bindings: getLibcurlBindings(),
    maxQueuedBytesHighWater: 0,
    options,
    pollEntered: 0,
    pollExited: 0,
    pools: new Map<string, Pool>(),
  };
  const controller = createPoolController(runtime);

  const submit = (identity: LibcurlPoolIdentity, request: LibcurlRequestInit): Promise<Response> =>
    submitLibcurlRequest(runtime, controller, identity, request);

  const drain = async (keyOrScope: string): Promise<void> => {
    const targets = [...runtime.pools.values()].filter(
      (pool) => pool.key === keyOrScope || pool.scope === keyOrScope,
    );
    await Promise.all(targets.map((pool) => controller.drainPool(pool)));
  };

  const drainWhere = async (predicate: (pool: LibcurlPoolIdentity) => boolean): Promise<void> => {
    await Promise.all(
      [...runtime.pools.values()]
        .filter((pool) => predicate(pool))
        .map((pool) => controller.drainPool(pool)),
    );
  };

  const drainAll = async (): Promise<void> => {
    await Promise.all([...runtime.pools.values()].map((pool) => controller.drainPool(pool)));
  };

  const stats = (): LibcurlMultiDriverStats => {
    let inFlight = 0;
    let paused = 0;
    let bufferedBodyBytes = 0;
    let polling = 0;
    for (const pool of runtime.pools.values()) {
      inFlight += pool.inflight.size;
      if (pool.polling) polling += 1;
      for (const req of pool.inflight.values()) {
        if (req.paused) paused += 1;
        bufferedBodyBytes += req.body.bufferedBytes;
        noteQueued(runtime, req.body.maxQueuedBytes);
      }
    }
    return {
      bufferedBodyBytes,
      inFlight,
      maxQueuedBytes: runtime.maxQueuedBytesHighWater,
      paused,
      pollEntered: runtime.pollEntered,
      pollExited: runtime.pollExited,
      polling,
      pools: runtime.pools.size,
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
