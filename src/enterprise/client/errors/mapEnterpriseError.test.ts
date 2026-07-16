import { describe, expect, it } from 'vitest';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';

import { mapEnterpriseError } from './mapEnterpriseError';

describe('mapEnterpriseError (structured)', () => {
  it('reads tRPC errorData body', () => {
    const mapped = mapEnterpriseError({
      data: {
        errorData: {
          code: PLATFORM_ERROR_CODES.PLATFORM_ACCESS_NOT_GRANTED,
          details: { permissionRequestUrl: 'https://iam.example/request' },
        },
      },
      message: 'ignored',
    });
    expect(mapped?.code).toBe(PLATFORM_ERROR_CODES.PLATFORM_ACCESS_NOT_GRANTED);
    expect(mapped?.action).toBe('request_access');
    expect(mapped?.details?.permissionRequestUrl).toBe('https://iam.example/request');
  });

  it('reads cause.data body', () => {
    const mapped = mapEnterpriseError({
      cause: {
        data: { code: PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED },
      },
      message: 'x',
    });
    expect(mapped?.code).toBe(PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED);
    expect(mapped?.action).toBe('contact_admin');
  });

  it('falls back to free-text message codes', () => {
    const mapped = mapEnterpriseError(PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT);
    expect(mapped?.code).toBe(PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT);
    expect(mapped?.action).toBe('retry');
  });

  it('returns null for unknown errors', () => {
    expect(mapEnterpriseError(new Error('boom'))).toBeNull();
  });
});
