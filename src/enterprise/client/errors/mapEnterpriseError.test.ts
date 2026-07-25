import { describe, expect, it } from 'vitest';

import {
  MANAGED_ERROR_CODES,
  PLATFORM_CONNECTOR_ERROR_CODES,
  PLATFORM_ERROR_CODES,
} from '@/const/platform/errorCodes';

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

  it('maps skill_import_* details.reason to skillCatalog.import.error.* (not raw code)', () => {
    const mapped = mapEnterpriseError({
      data: {
        errorData: {
          code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
          details: { reason: 'skill_import_timeout' },
          message: 'skill_import_timeout',
        },
      },
      message: 'skill_import_timeout',
    });
    expect(mapped?.code).toBe(PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT);
    expect(mapped?.i18nKey).toBe('skillCatalog.import.error.skill_import_timeout');
    expect(mapped?.details?.reason).toBe('skill_import_timeout');
  });

  it('maps free-text skill_import_* messages to skill import locale keys', () => {
    const mapped = mapEnterpriseError('skill_import_zip_too_large');
    expect(mapped?.code).toBe(PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT);
    expect(mapped?.i18nKey).toBe('skillCatalog.import.error.skill_import_zip_too_large');
    expect(mapped?.details?.reason).toBe('skill_import_zip_too_large');
  });

  it('keeps PLATFORM_INVALID_INPUT generic when reason is not skill_import_*', () => {
    const mapped = mapEnterpriseError({
      data: {
        errorData: {
          code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
          details: { reason: 'email_taken' },
        },
      },
    });
    expect(mapped?.i18nKey).toBe('enterprise.error.PLATFORM_INVALID_INPUT');
  });

  it('maps PLATFORM_RESOURCE_IN_USE + purge_in_progress to legal-hold-specific copy', () => {
    const mapped = mapEnterpriseError({
      data: {
        errorData: {
          code: PLATFORM_ERROR_CODES.PLATFORM_RESOURCE_IN_USE,
          details: { reason: 'purge_in_progress' },
        },
      },
    });
    expect(mapped?.code).toBe(PLATFORM_ERROR_CODES.PLATFORM_RESOURCE_IN_USE);
    expect(mapped?.action).toBe('retry');
    expect(mapped?.i18nKey).toBe('audit.legalHold.errors.purgeInProgress');
  });

  it('keeps PLATFORM_RESOURCE_IN_USE generic without purge_in_progress reason', () => {
    const mapped = mapEnterpriseError({
      data: {
        errorData: {
          code: PLATFORM_ERROR_CODES.PLATFORM_RESOURCE_IN_USE,
          details: { reason: 'agent_in_use' },
        },
      },
    });
    expect(mapped?.i18nKey).toBe('enterprise.error.PLATFORM_RESOURCE_IN_USE');
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

  it('maps PLATFORM_CONNECTOR_NOT_FOUND free-text to specific connector copy', () => {
    const mapped = mapEnterpriseError(PLATFORM_CONNECTOR_ERROR_CODES.PLATFORM_CONNECTOR_NOT_FOUND);
    expect(mapped).toMatchObject({
      action: 'retry',
      code: PLATFORM_CONNECTOR_ERROR_CODES.PLATFORM_CONNECTOR_NOT_FOUND,
      i18nKey: 'enterprise.error.PLATFORM_CONNECTOR_NOT_FOUND',
    });
  });

  it('maps structured connector errorData bodies', () => {
    const mapped = mapEnterpriseError({
      data: {
        errorData: {
          code: PLATFORM_CONNECTOR_ERROR_CODES.PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED,
        },
      },
      message: PLATFORM_CONNECTOR_ERROR_CODES.PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED,
    });
    expect(mapped?.code).toBe(
      PLATFORM_CONNECTOR_ERROR_CODES.PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED,
    );
    expect(mapped?.action).toBe('contact_admin');
    expect(mapped?.i18nKey).toBe('enterprise.error.PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
  });
});
