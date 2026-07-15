import {
  ADMIN_ERROR_CODES,
  ENTERPRISE_ERROR_CODES,
  type EnterpriseErrorCode,
  isEnterpriseErrorCode,
  MANAGED_ERROR_CODES,
  PLATFORM_ERROR_CODES,
} from '@/const/platform/errorCodes';

export interface MappedEnterpriseError {
  /** Suggested UX action for shared handlers. */
  action: 'signin' | 'reauth' | 'retry' | 'contact_admin' | 'none';
  code: EnterpriseErrorCode;
  i18nKey: string;
}

const ACTION_BY_CODE: Partial<Record<EnterpriseErrorCode, MappedEnterpriseError['action']>> = {
  [PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED]: 'contact_admin',
  [PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT]: 'retry',
  [PLATFORM_ERROR_CODES.PLATFORM_FEATURE_DISABLED]: 'none',
  [ADMIN_ERROR_CODES.ADMIN_ACCESS_DENIED]: 'contact_admin',
  [ADMIN_ERROR_CODES.ADMIN_REAUTH_REQUIRED]: 'reauth',
  [ADMIN_ERROR_CODES.ADMIN_FEATURE_DISABLED]: 'none',
  [MANAGED_ERROR_CODES.MANAGED_RESOURCE_BY_PLATFORM]: 'contact_admin',
  [MANAGED_ERROR_CODES.MANAGED_SETTING_BY_ADMIN]: 'contact_admin',
};

/**
 * Map free-form / tRPC error messages to stable enterprise codes for UI.
 *
 * TODO(M02): Prefer structured TRPCError `cause` / `data.errorData` carrying
 * `EnterpriseErrorBody` (`packages/types/src/platform/errors.ts`) instead of
 * parsing free-text `message`. Keep this message fallback for older callers.
 */
export const mapEnterpriseError = (error: unknown): MappedEnterpriseError | null => {
  const message =
    typeof error === 'string'
      ? error
      : error && typeof error === 'object' && 'message' in error
        ? String((error as { message?: unknown }).message ?? '')
        : '';

  const codeCandidate = message.trim();
  if (!isEnterpriseErrorCode(codeCandidate)) return null;

  return {
    action: ACTION_BY_CODE[codeCandidate] ?? 'none',
    code: codeCandidate,
    i18nKey: `enterprise.error.${codeCandidate}`,
  };
};

export const isKnownEnterpriseErrorMessage = (message: string): boolean =>
  isEnterpriseErrorCode(message.trim());

/** Re-export catalogs for UI bindings. */
export { ADMIN_ERROR_CODES, ENTERPRISE_ERROR_CODES, MANAGED_ERROR_CODES, PLATFORM_ERROR_CODES };
