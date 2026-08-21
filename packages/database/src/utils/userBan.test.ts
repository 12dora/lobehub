import { describe, expect, it } from 'vitest';

import { isCredentialInvalidated, isEffectivelyBanned } from './userBan';

describe('isEffectivelyBanned', () => {
  it('false when not banned', () => {
    expect(isEffectivelyBanned({ banExpires: null, banned: false })).toBe(false);
    expect(isEffectivelyBanned({ banExpires: null, banned: null })).toBe(false);
  });

  it('true for permanent ban', () => {
    expect(isEffectivelyBanned({ banExpires: null, banned: true })).toBe(true);
  });

  it('true for future temporary ban', () => {
    expect(
      isEffectivelyBanned({
        banExpires: new Date(Date.now() + 60_000),
        banned: true,
      }),
    ).toBe(true);
  });

  it('false when temporary ban expired', () => {
    expect(
      isEffectivelyBanned({
        banExpires: new Date(Date.now() - 1000),
        banned: true,
      }),
    ).toBe(false);
  });
});

describe('isCredentialInvalidated', () => {
  const cutoff = new Date('2024-06-01T12:00:00.000Z');
  const oldIssuance = new Date(cutoff.getTime() - 60_000);
  const newIssuance = new Date(cutoff.getTime() + 60_000);

  it('false when no cutoff', () => {
    expect(
      isCredentialInvalidated({ authInvalidatedAt: null }, { credentialIssuedAt: oldIssuance }),
    ).toBe(false);
  });

  it('true when credential at/before cutoff', () => {
    expect(
      isCredentialInvalidated({ authInvalidatedAt: cutoff }, { credentialIssuedAt: cutoff }),
    ).toBe(true);
    expect(
      isCredentialInvalidated({ authInvalidatedAt: cutoff }, { credentialIssuedAt: oldIssuance }),
    ).toBe(true);
  });

  it('false when credential after cutoff', () => {
    expect(
      isCredentialInvalidated({ authInvalidatedAt: cutoff }, { credentialIssuedAt: newIssuance }),
    ).toBe(false);
  });

  it('fails closed when cutoff set but credential time missing', () => {
    expect(
      isCredentialInvalidated({ authInvalidatedAt: cutoff }, { credentialIssuedAt: null }),
    ).toBe(true);
    expect(isCredentialInvalidated({ authInvalidatedAt: cutoff }, {})).toBe(true);
  });

  it('does not fail-closed on a cookie-cache session missing createdAt but carrying a sessionId', () => {
    expect(isCredentialInvalidated({ authInvalidatedAt: cutoff }, { sessionId: 'sess-live' })).toBe(
      false,
    );
    expect(
      isCredentialInvalidated(
        { authInvalidatedAt: cutoff },
        { credentialIssuedAt: null, sessionId: 'sess-live' },
      ),
    ).toBe(false);
  });

  it('session exception bypasses cutoff only for exact session id match', () => {
    const user = {
      authInvalidatedAt: cutoff,
      authInvalidatedExcludedSessionId: 'keep-sess',
    };
    // Matching session id: old issuance still allowed
    expect(
      isCredentialInvalidated(user, {
        credentialIssuedAt: oldIssuance,
        sessionId: 'keep-sess',
      }),
    ).toBe(false);
    // Different session id: fails
    expect(
      isCredentialInvalidated(user, {
        credentialIssuedAt: oldIssuance,
        sessionId: 'other-sess',
      }),
    ).toBe(true);
    // No session id (OIDC/API key): fails even with same old issuance
    expect(
      isCredentialInvalidated(user, {
        credentialIssuedAt: oldIssuance,
        sessionId: null,
      }),
    ).toBe(true);
  });
});
