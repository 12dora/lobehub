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

  it('false when no cutoff', () => {
    expect(isCredentialInvalidated({ authInvalidatedAt: null }, new Date('2020-01-01'))).toBe(
      false,
    );
  });

  it('true when credential at/before cutoff', () => {
    expect(isCredentialInvalidated({ authInvalidatedAt: cutoff }, cutoff)).toBe(true);
    expect(
      isCredentialInvalidated({ authInvalidatedAt: cutoff }, new Date(cutoff.getTime() - 1)),
    ).toBe(true);
  });

  it('false when credential after cutoff', () => {
    expect(
      isCredentialInvalidated({ authInvalidatedAt: cutoff }, new Date(cutoff.getTime() + 1)),
    ).toBe(false);
  });

  it('fails closed when cutoff set but credential time missing', () => {
    expect(isCredentialInvalidated({ authInvalidatedAt: cutoff }, null)).toBe(true);
    expect(isCredentialInvalidated({ authInvalidatedAt: cutoff }, undefined)).toBe(true);
  });
});
