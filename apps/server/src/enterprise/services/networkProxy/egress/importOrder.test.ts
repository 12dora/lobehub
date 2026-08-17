// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('networkProxy egress/snapshot import order', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('imports egress/scope first then snapshot without throwing', async () => {
    const scope = await import('./scope');
    const snapshot = await import('../snapshot');
    expect(typeof snapshot.onNetworkProxySnapshotChange).toBe('function');
    expect(() => scope.bindEgressCacheInvalidation()).not.toThrow();
  }, 20_000);

  it('imports snapshot first then egress/scope without throwing', async () => {
    const snapshot = await import('../snapshot');
    const scope = await import('./scope');
    expect(typeof snapshot.onNetworkProxySnapshotChange).toBe('function');
    expect(() => scope.bindEgressCacheInvalidation()).not.toThrow();
  }, 20_000);
});
