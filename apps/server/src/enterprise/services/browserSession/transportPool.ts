import { digestBrowserSessionMaterial } from './identity';

/**
 * Process-local impersonated HTTP/2 pool bookkeeping.
 *
 * `bind`/`has` keep the C1 handle map for tests and any sidecar a caller
 * still attaches. `drain(key)` also drops every in-process libcurl pool
 * whose scope was derived from that context (`context.transportPoolKey`).
 *
 * Pool key: browser context + origin + proxy/egress outlet + impersonation
 * profile revision.
 */
export interface BrowserSessionTransportHandle {
  drain: () => void;
}

export interface BrowserSessionTransportPool {
  bind: (key: string, handle: BrowserSessionTransportHandle) => void;
  drain: (key: string) => void | Promise<void>;
  /** Shutdown / test reset only. Per-account cleanup must use {@link drain}. */
  drainAll?: () => void | Promise<void>;
  has: (key: string) => boolean;
}

const drainPersistentForKey = async (key: string): Promise<void> => {
  const { drainSharedLibcurlPools } = await import('./transport/multiDriver');
  await drainSharedLibcurlPools(key);
};

const drainAllPersistent = async (): Promise<void> => {
  const { drainAllSharedLibcurlPools } = await import('./transport/multiDriver');
  await drainAllSharedLibcurlPools();
};

type ScopeDrain = (key: string) => void | Promise<void>;
const extraScopeDrains = new Set<ScopeDrain>();
let extraDrainAll: (() => void | Promise<void>) | undefined;

/**
 * Provider transports (ChatGPT CLI children) register here so common dispose
 * can await their drain without importing provider code.
 */
export const registerBrowserSessionScopeDrain = (
  drain: ScopeDrain,
  drainAll?: () => void | Promise<void>,
): (() => void) => {
  extraScopeDrains.add(drain);
  if (drainAll) extraDrainAll = drainAll;
  return () => {
    extraScopeDrains.delete(drain);
    if (extraDrainAll === drainAll) extraDrainAll = undefined;
  };
};

const runExtraDrains = async (key: string): Promise<void> => {
  await Promise.all([...extraScopeDrains].map((drain) => Promise.resolve(drain(key))));
};

export const buildBrowserSessionTransportPoolKey = (params: {
  contextId: string;
  impersonationProfileRevision?: string;
  origin: string;
  proxyOutlet?: string;
}): string =>
  digestBrowserSessionMaterial(
    [
      'transport-pool',
      params.contextId,
      params.origin,
      params.proxyOutlet ?? '',
      params.impersonationProfileRevision ?? '',
    ].join('\0'),
  );

export const createBrowserSessionTransportPool = (): BrowserSessionTransportPool => {
  const handles = new Map<string, BrowserSessionTransportHandle>();

  return {
    bind: (key, handle) => {
      handles.set(key, handle);
    },
    drain: (key) => {
      const handle = handles.get(key);
      handles.delete(key);
      handle?.drain();
      return Promise.all([drainPersistentForKey(key), runExtraDrains(key)]).then(() => undefined);
    },
    drainAll: () => {
      for (const [key, handle] of handles) {
        handles.delete(key);
        handle.drain();
      }
      return Promise.all([
        drainAllPersistent(),
        extraDrainAll ? Promise.resolve(extraDrainAll()) : Promise.resolve(),
      ]).then(() => undefined);
    },
    has: (key) => handles.has(key),
  };
};
