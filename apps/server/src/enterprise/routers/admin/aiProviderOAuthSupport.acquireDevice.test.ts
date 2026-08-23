import { afterEach, describe, expect, it, vi } from 'vitest';

import { toDevicePollSharedTokens } from './aiProviderOAuthSupport.acquireDevice';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('toDevicePollSharedTokens', () => {
  it('prefers expiresIn over the JWT exp claim', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);

    expect(
      toDevicePollSharedTokens({
        accessToken: 'token',
        expiresIn: 60,
        tokenType: 'Bearer',
      }),
    ).toEqual({
      accessToken: 'token',
      expiresAt: 1_700_000_060_000,
    });
  });

  it('omits identity and refresh leaves that the poll did not return', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);

    expect(
      toDevicePollSharedTokens({
        accessToken: 'token',
        accountId: 'acct',
        email: 'a@b.c',
        refreshToken: 'refresh',
        renewalKind: 'oauth',
        tokenType: 'Bearer',
      }),
    ).toEqual({
      accessToken: 'token',
      accountId: 'acct',
      email: 'a@b.c',
      refreshToken: 'refresh',
      renewalKind: 'oauth',
    });
  });
});
