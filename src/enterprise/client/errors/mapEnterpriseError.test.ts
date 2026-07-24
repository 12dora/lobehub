import { describe, expect, it } from 'vitest';

import { MANAGED_ERROR_CODES, PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';

import { mapEnterpriseError } from './mapEnterpriseError';

describe('mapEnterpriseError (structured)', () => {
  it('reads tRPC errorData body', () => {
    const mapped = mapEnterpriseError({
      data: {
        errorData: {
          code: PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED,
          details: { path: 'admin.system.getStatus' },
        },
      },
      message: 'ignored',
    });
    expect(mapped?.code).toBe(PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED);
    expect(mapped?.action).toBe('contact_admin');
    expect(mapped?.details?.path).toBe('admin.system.getStatus');
  });

  it('accepts MANAGED_AGENT_BATCH_LIMIT and forwards details.max', () => {
    const mapped = mapEnterpriseError({
      data: {
        errorData: {
          code: MANAGED_ERROR_CODES.MANAGED_AGENT_BATCH_LIMIT,
          details: { max: 100, reason: 'managed_agent_batch_limit' },
        },
      },
    });
    expect(mapped?.code).toBe(MANAGED_ERROR_CODES.MANAGED_AGENT_BATCH_LIMIT);
    expect(mapped?.i18nKey).toBe('enterprise.error.MANAGED_AGENT_BATCH_LIMIT');
    expect(mapped?.details?.max).toBe(100);
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

  it('normalizes a legacy alias delivered via cause.data, not only via free text', () => {
    const mapped = mapEnterpriseError({
      cause: { data: { code: 'RESOURCE_MANAGED_BY_PLATFORM' } },
      message: 'x',
    });
    expect(mapped?.code).toBe(MANAGED_ERROR_CODES.MANAGED_RESOURCE_BY_PLATFORM);
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
