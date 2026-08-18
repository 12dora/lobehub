import { describe, expect, it } from 'vitest';

import { readEnterpriseErrorBodies, readEnterpriseErrorBody } from './enterpriseErrorBody';

describe('readEnterpriseErrorBody', () => {
  it('reads a tRPC formatted body — code, message and details', () => {
    const error = Object.assign(new Error('PLATFORM_CONFIG_VALIDATION_FAILED'), {
      data: {
        errorData: {
          code: 'PLATFORM_CONFIG_VALIDATION_FAILED',
          details: { issueCount: 2, reason: 'shared_account_not_connected' },
          message: 'connection_failed_auth',
        },
      },
    });

    expect(readEnterpriseErrorBody(error)).toEqual({
      code: 'PLATFORM_CONFIG_VALIDATION_FAILED',
      details: { issueCount: 2, reason: 'shared_account_not_connected' },
      message: 'connection_failed_auth',
    });
  });

  it('reads a raw TRPCError cause', () => {
    const error = { cause: { data: { code: 'PLATFORM_NOT_FOUND' } } };

    expect(readEnterpriseErrorBody(error)?.code).toBe('PLATFORM_NOT_FOUND');
  });

  it('reads the nested json shape some clients hand back', () => {
    const error = { json: { data: { errorData: { code: 'ADMIN_ACCESS_DENIED' } } } };

    expect(readEnterpriseErrorBody(error)?.code).toBe('ADMIN_ACCESS_DENIED');
  });

  it('still returns a body that carries details only', () => {
    // Older payloads ship no code at all; the toasts that read `details.reason` depend on it.
    const error = { data: { errorData: { details: { reason: 'cannot_enumerate' } } } };

    expect(readEnterpriseErrorBody(error)).toEqual({
      code: undefined,
      details: { reason: 'cannot_enumerate' },
      message: undefined,
    });
  });

  it('drops values that are not a body', () => {
    expect(readEnterpriseErrorBody(new Error('boom'))).toBeUndefined();
    expect(readEnterpriseErrorBody('boom')).toBeUndefined();
    expect(readEnterpriseErrorBody(undefined)).toBeUndefined();
    expect(readEnterpriseErrorBody({ data: { errorData: 'boom' } })).toBeUndefined();
  });

  it('keeps every candidate in transport order, so a caller can keep walking', () => {
    // The first body's code is not in the catalog; a caller looking for one must still reach
    // the second, which is exactly what mapEnterpriseError does.
    const error = {
      cause: { data: { code: 'MANAGED_RESOURCE_BY_PLATFORM' } },
      data: { errorData: { code: 'SOMETHING_ELSE' } },
    };

    expect(readEnterpriseErrorBodies(error).map((body) => body.code)).toEqual([
      'SOMETHING_ELSE',
      'MANAGED_RESOURCE_BY_PLATFORM',
    ]);
  });

  it('normalizes a non-string code to text rather than leaking the value', () => {
    expect(readEnterpriseErrorBody({ data: { errorData: { code: 42 } } })?.code).toBe('42');
  });
});
