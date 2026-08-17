import { describe, expect, it } from 'vitest';

import {
  ADMIN_ERROR_CODES,
  ENTERPRISE_ERROR_CODES,
  isEnterpriseErrorCode,
  MANAGED_ERROR_CODES,
  PLATFORM_CONNECTOR_ERROR_CODES,
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
    expect(PLATFORM_ERROR_CODES.PLATFORM_MODULE_DISABLED).toBe('PLATFORM_MODULE_DISABLED');
    expect(isEnterpriseErrorCode('PLATFORM_MODULE_DISABLED')).toBe(true);
    expect(PLATFORM_ERROR_CODES.PLATFORM_LAST_SUPER_ADMIN).toBe('PLATFORM_LAST_SUPER_ADMIN');
    expect(PLATFORM_ERROR_CODES.PLATFORM_AI_MODEL_NOT_PUBLISHED).toBe(
      'PLATFORM_AI_MODEL_NOT_PUBLISHED',
    );
    expect(PLATFORM_ERROR_CODES.PLATFORM_AI_PROVIDER_DISABLED).toBe(
      'PLATFORM_AI_PROVIDER_DISABLED',
    );
    expect(PLATFORM_ERROR_CODES.PLATFORM_NETWORK_PROXY_GEODATA_MISSING).toBe(
      'PLATFORM_NETWORK_PROXY_GEODATA_MISSING',
    );
    expect(isEnterpriseErrorCode('PLATFORM_NETWORK_PROXY_GEODATA_MISSING')).toBe(true);
  });

  it('exposes admin and managed codes', () => {
    expect(ADMIN_ERROR_CODES.ADMIN_REAUTH_REQUIRED).toBe('ADMIN_REAUTH_REQUIRED');
    expect(MANAGED_ERROR_CODES.MANAGED_RESOURCE_BY_PLATFORM).toBe('MANAGED_RESOURCE_BY_PLATFORM');
    expect(MANAGED_ERROR_CODES.RESOURCE_MANAGED_BY_PLATFORM).toBe('RESOURCE_MANAGED_BY_PLATFORM');
    expect(MANAGED_ERROR_CODES.MANAGED_AGENT_BATCH_LIMIT).toBe('MANAGED_AGENT_BATCH_LIMIT');
    expect(isEnterpriseErrorCode('MANAGED_AGENT_BATCH_LIMIT')).toBe(true);
  });

  it('registers every connector domain code in the enterprise catalog', () => {
    for (const code of Object.values(PLATFORM_CONNECTOR_ERROR_CODES)) {
      expect(isEnterpriseErrorCode(code)).toBe(true);
      expect(ENTERPRISE_ERROR_CODES[code as keyof typeof ENTERPRISE_ERROR_CODES]).toBe(code);
    }
    expect(isEnterpriseErrorCode(PLATFORM_CONNECTOR_ERROR_CODES.PLATFORM_CONNECTOR_NOT_FOUND)).toBe(
      true,
    );
  });

  it('type-guards known codes only', () => {
    expect(isEnterpriseErrorCode('PLATFORM_PERMISSION_DENIED')).toBe(true);
    expect(isEnterpriseErrorCode('RANDOM_ERROR')).toBe(false);
    expect(isEnterpriseErrorCode('PERMISSION_DENIED')).toBe(false);
  });
});
