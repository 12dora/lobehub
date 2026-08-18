import { APIError } from 'better-auth/api';
import { describe, expect, it } from 'vitest';

import {
  assertPasskeyUserVerified,
  PASSKEY_USER_VERIFICATION_REQUIRED_CODE,
} from './passkey-user-verification';

describe('assertPasskeyUserVerified', () => {
  it('accepts an assertion whose UV flag is set', () => {
    expect(() =>
      assertPasskeyUserVerified({ authenticationInfo: { userVerified: true } }),
    ).not.toThrow();
  });

  it.each([
    { authenticationInfo: { userVerified: false } },
    { authenticationInfo: {} },
    {},
    { authenticationInfo: null },
  ])('rejects %j', (verification) => {
    try {
      assertPasskeyUserVerified(verification);
      expect.unreachable('expected UV rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(APIError);
      expect((error as InstanceType<typeof APIError>).body?.code).toBe(
        PASSKEY_USER_VERIFICATION_REQUIRED_CODE,
      );
    }
  });
});
