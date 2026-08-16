import { TRPCError } from '@trpc/server';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';

import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import { PlatformSecretError } from '../../security/secret';
import { IdentityProviderValidationError } from '../../services/identityProvider/discoveryValidator';

const enterpriseCodeFromError = (error: unknown): string | null => {
  if (error instanceof PlatformSecretError) return error.code;
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
};

export const execute = async <T>(operation: () => Promise<T> | T): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof IdentityProviderValidationError) {
      return throwEnterpriseError({
        code:
          error.code === 'OIDC_NETWORK_BLOCKED'
            ? PLATFORM_ERROR_CODES.PLATFORM_SSRF_BLOCKED
            : PLATFORM_ERROR_CODES.PLATFORM_OIDC_DISCOVERY_FAILED,
      });
    }
    // Real path when ENABLE_DATABASE_OIDC=1 without PLATFORM_MASTER_KEY:
    // PlatformSecretService.fromEnvOrThrowIfEnterprise throws PlatformSecretError
    // (message is a prose string; stable code lives on `.code`).
    const enterpriseCode = enterpriseCodeFromError(error);
    if (enterpriseCode === PLATFORM_ERROR_CODES.PLATFORM_SECRET_REQUIRED) {
      return throwEnterpriseError({ code: PLATFORM_ERROR_CODES.PLATFORM_SECRET_REQUIRED });
    }
    if (enterpriseCode === PLATFORM_ERROR_CODES.PLATFORM_SECRET_NOT_READABLE) {
      return throwEnterpriseError({ code: PLATFORM_ERROR_CODES.PLATFORM_SECRET_NOT_READABLE });
    }
    if (enterpriseCode === PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT) {
      return throwEnterpriseError({ code: PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT });
    }
    const message = error instanceof Error ? error.message : '';
    // Legacy string throws from support helpers (APP_URL gap, explicit SECRET_REQUIRED).
    if (message.includes('PLATFORM_SECRET_REQUIRED') || message === 'PLATFORM_SECRET_REQUIRED') {
      return throwEnterpriseError({ code: PLATFORM_ERROR_CODES.PLATFORM_SECRET_REQUIRED });
    }
    // APP_URL missing is a deploy-time config gap; preserve stable message for setup guidance UI.
    if (message.includes('PLATFORM_APP_URL_INVALID') || message === 'PLATFORM_APP_URL_INVALID') {
      return throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
        message: 'PLATFORM_APP_URL_INVALID',
      });
    }
    if (message.includes('REVISION_CONFLICT') || message.includes('revision changed')) {
      return throwEnterpriseError({ code: PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT });
    }
    if (message.includes('NOT_FOUND')) {
      return throwEnterpriseError({ code: PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND });
    }
    if (message.includes('SECRET_UNAVAILABLE') || message.includes('SECRET_NOT_READABLE')) {
      return throwEnterpriseError({ code: PLATFORM_ERROR_CODES.PLATFORM_SECRET_NOT_READABLE });
    }
    if (message.includes('DRAFT_REQUIRED') || message.includes('NOT_DRAFT')) {
      return throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
        details: { reason: 'identity_provider_draft_required' },
        httpCode: 'PRECONDITION_FAILED',
      });
    }
    if (message.includes('CORP_ALLOWLIST_REQUIRED')) {
      return throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
        details: { reason: 'identity_provider_corp_allowlist_required' },
        httpCode: 'PRECONDITION_FAILED',
      });
    }
    if (message.includes('NOT_TESTED')) {
      return throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
        details: { reason: 'identity_provider_test_required' },
        httpCode: 'PRECONDITION_FAILED',
      });
    }
    if (message.includes('INVALID_SNAPSHOT')) {
      return throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
        httpCode: 'PRECONDITION_FAILED',
      });
    }
    // Untyped / unexpected failures are infrastructure or programming errors —
    // do not mislabel them as client input validation.
    console.error('[admin.identityProviders] unexpected operation failure', {
      errorClass: error instanceof Error ? error.name : 'UnknownError',
      message: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
    });
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Identity provider operation failed',
    });
  }
};
