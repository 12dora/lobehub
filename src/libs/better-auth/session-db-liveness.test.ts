import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OIDCUserInactiveError } from '@/libs/oidc-provider/access-control';
import { assertUserActiveCached } from '@/libs/oidc-provider/userActiveCache';

import { attachBetterAuthSessionLiveness } from './session-db-liveness';

vi.mock('@/libs/oidc-provider/userActiveCache', () => ({
  assertUserActiveCached: vi.fn(),
}));

describe('attachBetterAuthSessionLiveness', () => {
  const found = {
    session: { createdAt: new Date('2026-01-01T00:00:00.000Z'), id: 'sess-1' },
    user: { id: 'user-1' },
  };

  beforeEach(() => {
    vi.mocked(assertUserActiveCached).mockReset();
    vi.mocked(assertUserActiveCached).mockResolvedValue(undefined);
  });

  it('returns null when Redis still has a session whose database row is gone', async () => {
    const findSession = vi.fn(async () => found);
    const auth = { $context: Promise.resolve({ internalAdapter: { findSession } }) };

    vi.mocked(assertUserActiveCached).mockRejectedValueOnce(new OIDCUserInactiveError());
    attachBetterAuthSessionLiveness(auth, {} as never);

    const ctx = await auth.$context;
    await expect(ctx.internalAdapter.findSession('stale-token')).resolves.toBeNull();
    expect(assertUserActiveCached).toHaveBeenCalledWith({} as never, 'user-1', {
      credentialIssuedAt: found.session.createdAt,
      sessionId: 'sess-1',
    });
  });

  it('rethrows backend failures instead of treating them as unauthenticated', async () => {
    const findSession = vi.fn(async () => found);
    const auth = { $context: Promise.resolve({ internalAdapter: { findSession } }) };
    const backendError = new Error('database unavailable');
    vi.mocked(assertUserActiveCached).mockRejectedValueOnce(backendError);
    attachBetterAuthSessionLiveness(auth, {} as never);

    const ctx = await auth.$context;
    await expect(ctx.internalAdapter.findSession('tok')).rejects.toBe(backendError);
  });

  it('passes through a live session', async () => {
    const findSession = vi.fn(async () => found);
    const auth = { $context: Promise.resolve({ internalAdapter: { findSession } }) };
    attachBetterAuthSessionLiveness(auth, {} as never);

    const ctx = await auth.$context;
    await expect(ctx.internalAdapter.findSession('tok')).resolves.toEqual(found);
  });

  it('no-ops when betterAuth is not an auth instance (test mock identity)', () => {
    expect(() => attachBetterAuthSessionLiveness({ plugins: [] }, {} as never)).not.toThrow();
  });
});
