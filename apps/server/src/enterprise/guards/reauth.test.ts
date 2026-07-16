import { describe, expect, it } from 'vitest';

import { ADMIN_ERROR_CODES } from '@/const/platform/errorCodes';

import { getEnterpriseErrorBody } from './enterpriseErrors';
import { assertRecentReauth } from './reauth';

describe('assertRecentReauth', () => {
  it('allows recent better-auth / oidc / dev-mock', () => {
    expect(() =>
      assertRecentReauth({
        authenticatedAt: new Date(),
        authMethod: 'better-auth',
      }),
    ).not.toThrow();
    expect(() =>
      assertRecentReauth({
        authenticatedAt: new Date(),
        authMethod: 'oidc',
      }),
    ).not.toThrow();
    expect(() =>
      assertRecentReauth({
        authenticatedAt: new Date(),
        authMethod: 'dev-mock',
      }),
    ).not.toThrow();
  });

  it('rejects api-key even with a timestamp', () => {
    try {
      assertRecentReauth({
        authenticatedAt: new Date(),
        authMethod: 'api-key',
      });
      expect.fail('expected throw');
    } catch (error) {
      expect(getEnterpriseErrorBody(error)?.code).toBe(ADMIN_ERROR_CODES.ADMIN_REAUTH_REQUIRED);
    }
  });

  it('rejects missing authenticatedAt', () => {
    try {
      assertRecentReauth({ authMethod: 'better-auth', authenticatedAt: null });
      expect.fail('expected throw');
    } catch (error) {
      expect(getEnterpriseErrorBody(error)?.code).toBe(ADMIN_ERROR_CODES.ADMIN_REAUTH_REQUIRED);
    }
  });

  it('rejects stale authenticatedAt', () => {
    try {
      assertRecentReauth({
        authenticatedAt: new Date(Date.now() - 60 * 60 * 1000),
        authMethod: 'better-auth',
      });
      expect.fail('expected throw');
    } catch (error) {
      expect(getEnterpriseErrorBody(error)?.code).toBe(ADMIN_ERROR_CODES.ADMIN_REAUTH_REQUIRED);
    }
  });
});
