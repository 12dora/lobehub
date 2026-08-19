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

const deferDrain = (fn: () => void | Promise<void>): Promise<void> =>
  Promise.resolve().then(() => fn());

const awaitAllDrains = async (tasks: Array<() => void | Promise<void>>): Promise<void> => {
  const results = await Promise.allSettled(tasks.map((task) => deferDrain(task)));
  const rejected = results.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (rejected.length === 0) return;
  const detail = rejected
    .map((result) => (result.reason instanceof Error ? result.reason.message : 'UnknownError'))
    .join('; ');
  throw new AggregateError(
    rejected.map((result) => result.reason),
    `browser session drain failed: ${detail}`,
  );
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
      return awaitAllDrains([
        () => handle?.drain(),
        () => drainPersistentForKey(key),
        ...[...extraScopeDrains].map((drain) => () => drain(key)),
      ]);
    },
    drainAll: () => {
      const handleDrains = [...handles.entries()].map(([, handle]) => {
        return () => handle.drain();
      });
      handles.clear();
      return awaitAllDrains([...handleDrains, () => drainAllPersistent(), () => extraDrainAll?.()]);
    },
    has: (key) => handles.has(key),
  };
};
