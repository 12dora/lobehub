import { describe, expect, it } from 'vitest';

import {
  ADMIN_ERROR_CODES,
  ENTERPRISE_ERROR_CODES,
  isEnterpriseErrorCode,
  MANAGED_ERROR_CODES,
  PLATFORM_ERROR_CODES,
} from './errorCodes';

// Naming-convention invariant lives with the test that enforces it — no runtime code consumes it.
// 'RESOURCE_' is the M06 public-contract spelling retained for legacy-router compatibility.
const ENTERPRISE_ERROR_CODE_PREFIXES = ['PLATFORM_', 'ADMIN_', 'MANAGED_', 'RESOURCE_'] as const;
const hasEnterpriseErrorPrefix = (code: string): boolean =>
  ENTERPRISE_ERROR_CODE_PREFIXES.some((prefix) => code.startsWith(prefix));

describe('enterprise error codes', () => {
  it('uses only approved enterprise prefixes', () => {
    for (const code of Object.values(ENTERPRISE_ERROR_CODES)) {
      expect(hasEnterpriseErrorPrefix(code)).toBe(true);
    }
  });

  it('exposes stable platform codes for revision and permission failures', () => {
    expect(PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED).toBe('PLATFORM_PERMISSION_DENIED');
    expect(PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT).toBe('PLATFORM_REVISION_CONFLICT');
    expect(PLATFORM_ERROR_CODES.PLATFORM_FEATURE_DISABLED).toBe('PLATFORM_FEATURE_DISABLED');
    expect(PLATFORM_ERROR_CODES.PLATFORM_LAST_SUPER_ADMIN).toBe('PLATFORM_LAST_SUPER_ADMIN');
    expect(PLATFORM_ERROR_CODES.PLATFORM_AI_MODEL_NOT_PUBLISHED).toBe(
      'PLATFORM_AI_MODEL_NOT_PUBLISHED',
    );
    expect(PLATFORM_ERROR_CODES.PLATFORM_AI_PROVIDER_DISABLED).toBe(
      'PLATFORM_AI_PROVIDER_DISABLED',
    );
  });

  it('exposes admin and managed codes', () => {
    expect(ADMIN_ERROR_CODES.ADMIN_REAUTH_REQUIRED).toBe('ADMIN_REAUTH_REQUIRED');
    expect(MANAGED_ERROR_CODES.MANAGED_RESOURCE_BY_PLATFORM).toBe('MANAGED_RESOURCE_BY_PLATFORM');
    expect(MANAGED_ERROR_CODES.RESOURCE_MANAGED_BY_PLATFORM).toBe('RESOURCE_MANAGED_BY_PLATFORM');
  });

  it('type-guards known codes only', () => {
    expect(isEnterpriseErrorCode('PLATFORM_PERMISSION_DENIED')).toBe(true);
    expect(isEnterpriseErrorCode('RANDOM_ERROR')).toBe(false);
    expect(isEnterpriseErrorCode('PERMISSION_DENIED')).toBe(false);
  });
});
