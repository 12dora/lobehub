import { describe, expect, it } from 'vitest';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';

import { mapEnterpriseCodeToTrpc, throwEnterpriseError } from './enterpriseErrors';

describe('mapEnterpriseCodeToTrpc', () => {
  it('maps PLATFORM_MODULE_DISABLED to FORBIDDEN', () => {
    expect(mapEnterpriseCodeToTrpc(PLATFORM_ERROR_CODES.PLATFORM_MODULE_DISABLED)).toBe(
      'FORBIDDEN',
    );
  });

  it('throws a structured body with moduleId details', () => {
    try {
      throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_MODULE_DISABLED,
        details: { moduleId: 'audit' },
      });
    } catch (error) {
      expect((error as { code: string }).code).toBe('FORBIDDEN');
      expect((error as { cause: { data: { details: unknown } } }).cause.data.details).toEqual({
        moduleId: 'audit',
      });
    }
  });
});
