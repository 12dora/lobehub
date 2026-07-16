import { describe, expect, it } from 'vitest';

import type { ConnectorOAuthStateBackend } from './oauthStateStore';
import { ConnectorOAuthStateStore } from './oauthStateStore';

class MemoryAtomicStateBackend implements ConnectorOAuthStateBackend {
  readonly values = new Map<string, string>();

  putIfAbsent = async (key: string, value: string): Promise<boolean> => {
    if (this.values.has(key)) return false;
    this.values.set(key, value);
    return true;
  };

  take = async (key: string): Promise<string | null> => {
    const value = this.values.get(key) ?? null;
    this.values.delete(key);
    return value;
  };
}

const stateInput = {
  bindingId: 'binding-1',
  codeChallengeMethod: 'S256' as const,
  codeVerifier: 'v'.repeat(43),
  connectorId: 'connector-1',
  publishedRevision: 3,
  redirectUri: 'https://aihub.example.test/oauth/connector/callback',
  returnTo: '/settings/connectors',
  scopes: ['issues:read'],
  userId: 'user-1',
};

describe('ConnectorOAuthStateStore', () => {
  it('binds the complete server-only payload and consumes it exactly once', async () => {
    const backend = new MemoryAtomicStateBackend();
    const store = new ConnectorOAuthStateStore({
      backend,
      clock: () => 1_000,
      createOpaqueState: () => 's'.repeat(43),
    });

    const state = await store.issue(stateInput);
    await expect(store.consume(state)).resolves.toMatchObject({
      ...stateInput,
      expiresAt: 601_000,
      issuedAt: 1_000,
    });
    await expect(store.consume(state)).rejects.toMatchObject({
      code: 'PLATFORM_CONNECTOR_OAUTH_STATE_INVALID',
    });
  });

  it('permits only one winner when callbacks race to consume the same state', async () => {
    const backend = new MemoryAtomicStateBackend();
    const store = new ConnectorOAuthStateStore({
      backend,
      createOpaqueState: () => 'r'.repeat(43),
    });
    const state = await store.issue(stateInput);

    const results = await Promise.allSettled([store.consume(state), store.consume(state)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('rejects expired or malformed payloads after atomically destroying them', async () => {
    const backend = new MemoryAtomicStateBackend();
    const store = new ConnectorOAuthStateStore({ backend, clock: () => 10_000 });
    backend.values.set(
      'e'.repeat(32),
      JSON.stringify({ ...stateInput, expiresAt: 9_999, issuedAt: 1 }),
    );
    await expect(store.consume('e'.repeat(32))).rejects.toMatchObject({
      code: 'PLATFORM_CONNECTOR_OAUTH_STATE_EXPIRED',
    });
    expect(backend.values.has('e'.repeat(32))).toBe(false);

    backend.values.set('m'.repeat(32), '{invalid');
    await expect(store.consume('m'.repeat(32))).rejects.toMatchObject({
      code: 'PLATFORM_CONNECTOR_OAUTH_STATE_INVALID',
    });
    expect(backend.values.has('m'.repeat(32))).toBe(false);
  });

  it('rejects TTLs that exceed the ten-minute authorization window', () => {
    expect(
      () =>
        new ConnectorOAuthStateStore({ backend: new MemoryAtomicStateBackend(), ttlMs: 600_001 }),
    ).toThrowError('PLATFORM_CONNECTOR_OAUTH_STATE_INVALID');
  });
});
