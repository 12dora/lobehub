import { describe, expect, it } from 'vitest';

import { MANAGED_ERROR_CODES, PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';

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

  it('normalizes the M06 RESOURCE_MANAGED_BY_PLATFORM spelling without removing legacy support', () => {
    expect(mapEnterpriseError('RESOURCE_MANAGED_BY_PLATFORM')).toMatchObject({
      action: 'contact_admin',
      code: MANAGED_ERROR_CODES.MANAGED_RESOURCE_BY_PLATFORM,
    });
    expect(mapEnterpriseError(MANAGED_ERROR_CODES.MANAGED_RESOURCE_BY_PLATFORM)).toMatchObject({
      action: 'contact_admin',
      code: MANAGED_ERROR_CODES.MANAGED_RESOURCE_BY_PLATFORM,
    });
  });

  it('returns null for unknown errors', () => {
    expect(mapEnterpriseError(new Error('boom'))).toBeNull();
  });
});
