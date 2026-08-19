import { digestBrowserSessionMaterial } from './identity';

/**
 * C3 will own real impersonated HTTP/2 pools. C1 only needs a stable key and a
 * drain hook so context invalidation can drop whatever C3 later binds.
 *
 * Pool key: browser context + origin + proxy/egress outlet + impersonation
 * profile revision.
 */
export interface BrowserSessionTransportHandle {
  drain: () => void;
}

export interface BrowserSessionTransportPool {
  bind: (key: string, handle: BrowserSessionTransportHandle) => void;
  drain: (key: string) => void;
  has: (key: string) => boolean;
}

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
    },
    has: (key) => handles.has(key),
  };
};
