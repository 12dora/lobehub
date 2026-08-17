import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OIDCUserInactiveError } from './access-control';
import {
  assertUserActiveCached,
  bumpUserActiveCacheEpoch,
  resetUserActiveCacheForTest,
} from './userActiveCache';

const assertUserActive = vi.hoisted(() => vi.fn());

vi.mock('./access-control', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    assertUserActive,
  };
});

const db = {} as never;

describe('assertUserActiveCached', () => {
  beforeEach(() => {
    resetUserActiveCacheForTest();
    assertUserActive.mockReset();
    assertUserActive.mockResolvedValue(undefined);
  });

  afterEach(() => {
    resetUserActiveCacheForTest();
  });

  it('computes once within TTL and returns the same success', async () => {
    const issuedAt = new Date('2026-01-01T00:00:00.000Z');
    await assertUserActiveCached(db, 'user-1', { credentialIssuedAt: issuedAt });
    await assertUserActiveCached(db, 'user-1', { credentialIssuedAt: issuedAt });

    expect(assertUserActive).toHaveBeenCalledTimes(1);
  });

  it('recomputes after an epoch bump', async () => {
    await assertUserActiveCached(db, 'user-1', { sessionId: 'sess-1' });
    bumpUserActiveCacheEpoch();
    await assertUserActiveCached(db, 'user-1', { sessionId: 'sess-1' });

    expect(assertUserActive).toHaveBeenCalledTimes(2);
  });

  it('does not remember a flight that started before an epoch bump', async () => {
    let release!: (value: void) => void;
    assertUserActive.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    const pending = assertUserActiveCached(db, 'user-race', {});
    bumpUserActiveCacheEpoch();
    release();
    await pending;

    assertUserActive.mockResolvedValue(undefined);
    await assertUserActiveCached(db, 'user-race', {});
    expect(assertUserActive).toHaveBeenCalledTimes(2);
  });

  it('still throws when the user is inactive, including on a cached miss', async () => {
    assertUserActive.mockRejectedValue(new OIDCUserInactiveError());

    await expect(assertUserActiveCached(db, 'banned', {})).rejects.toBeInstanceOf(
      OIDCUserInactiveError,
    );
    await expect(assertUserActiveCached(db, 'banned', {})).rejects.toBeInstanceOf(
      OIDCUserInactiveError,
    );
    expect(assertUserActive).toHaveBeenCalledTimes(1);
  });
});
