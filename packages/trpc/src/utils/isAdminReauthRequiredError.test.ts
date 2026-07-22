import { describe, expect, it } from 'vitest';

import { ADMIN_ERROR_CODES } from '@/const/platform/errorCodes';

import { isAdminReauthRequiredError, shouldLogoutOnLambda401 } from './isAdminReauthRequiredError';

describe('isAdminReauthRequiredError', () => {
  it('detects structured tRPC client errorData.code', () => {
    const error = {
      data: {
        errorData: { code: ADMIN_ERROR_CODES.ADMIN_REAUTH_REQUIRED },
        httpStatus: 401,
      },
      message: 'UNAUTHORIZED',
    };

    expect(isAdminReauthRequiredError(error)).toBe(true);
  });

  it('detects structured cause.data.code (server TRPCError shape)', () => {
    const error = {
      cause: {
        data: {
          code: ADMIN_ERROR_CODES.ADMIN_REAUTH_REQUIRED,
          details: { reason: 'stale_authenticated_at' },
        },
      },
      code: 'UNAUTHORIZED',
      message: ADMIN_ERROR_CODES.ADMIN_REAUTH_REQUIRED,
    };

    expect(isAdminReauthRequiredError(error)).toBe(true);
  });

  it('falls back to message compatibility used by enterprise helpers', () => {
    expect(isAdminReauthRequiredError(new Error('ADMIN_REAUTH_REQUIRED'))).toBe(true);
    expect(isAdminReauthRequiredError('ADMIN_REAUTH_REQUIRED')).toBe(true);
  });

  it('does not match genuine session UNAUTHORIZED without structured reauth code', () => {
    expect(
      isAdminReauthRequiredError({
        data: { httpStatus: 401 },
        message: 'UNAUTHORIZED',
      }),
    ).toBe(false);

    expect(
      isAdminReauthRequiredError({
        data: { errorData: { code: ADMIN_ERROR_CODES.ADMIN_ACCESS_DENIED } },
        message: 'FORBIDDEN',
      }),
    ).toBe(false);

    expect(isAdminReauthRequiredError(null)).toBe(false);
    expect(isAdminReauthRequiredError(undefined)).toBe(false);
  });
});

describe('shouldLogoutOnLambda401', () => {
  const reauth401 = {
    data: {
      errorData: { code: ADMIN_ERROR_CODES.ADMIN_REAUTH_REQUIRED },
      httpStatus: 401,
    },
    message: ADMIN_ERROR_CODES.ADMIN_REAUTH_REQUIRED,
  };

  const session401 = {
    data: { httpStatus: 401 },
    message: 'UNAUTHORIZED',
  };

  it('does not logout for structured ADMIN_REAUTH_REQUIRED 401', () => {
    expect(shouldLogoutOnLambda401({ error: reauth401, isMarketApi: false, status: 401 })).toBe(
      false,
    );
  });

  it('logs out for genuine non-market 401 session expiry', () => {
    expect(shouldLogoutOnLambda401({ error: session401, isMarketApi: false, status: 401 })).toBe(
      true,
    );
  });

  it('never logs out for market API 401 (market auth flow)', () => {
    expect(shouldLogoutOnLambda401({ error: session401, isMarketApi: true, status: 401 })).toBe(
      false,
    );
    expect(shouldLogoutOnLambda401({ error: reauth401, isMarketApi: true, status: 401 })).toBe(
      false,
    );
  });

  it('does not logout for non-401 statuses', () => {
    expect(shouldLogoutOnLambda401({ error: session401, isMarketApi: false, status: 403 })).toBe(
      false,
    );
  });
});
