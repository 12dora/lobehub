import {
  ADMIN_ERROR_CODES,
  ENTERPRISE_ERROR_CODES,
  type EnterpriseErrorCode,
  isEnterpriseErrorCode,
  MANAGED_ERROR_CODES,
  PLATFORM_ERROR_CODES,
} from '@/const/platform/errorCodes';
import type { EnterpriseErrorBody } from '@/types/platform/errors';

export interface MappedEnterpriseError {
  /** Suggested UX action for shared handlers. */
  action: 'signin' | 'reauth' | 'retry' | 'contact_admin' | 'none';
  code: EnterpriseErrorCode;
  details?: EnterpriseErrorBody['details'];
  i18nKey: string;
}

const ACTION_BY_CODE: Partial<Record<EnterpriseErrorCode, MappedEnterpriseError['action']>> = {
  [PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED]: 'contact_admin',
  [PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT]: 'retry',
  [PLATFORM_ERROR_CODES.PLATFORM_FEATURE_DISABLED]: 'none',
  [PLATFORM_ERROR_CODES.PLATFORM_LAST_SUPER_ADMIN]: 'none',
  [PLATFORM_ERROR_CODES.PLATFORM_AI_MODEL_NOT_PUBLISHED]: 'none',
  [ADMIN_ERROR_CODES.ADMIN_ACCESS_DENIED]: 'contact_admin',
  [ADMIN_ERROR_CODES.ADMIN_REAUTH_REQUIRED]: 'reauth',
  [ADMIN_ERROR_CODES.ADMIN_FEATURE_DISABLED]: 'none',
  [MANAGED_ERROR_CODES.MANAGED_RESOURCE_BY_PLATFORM]: 'contact_admin',
  [MANAGED_ERROR_CODES.MANAGED_SETTING_BY_ADMIN]: 'contact_admin',
  [MANAGED_ERROR_CODES.MANAGED_AGENT_BATCH_LIMIT]: 'none',
};

/** M06 contract spelling; normalize to the legacy catalog entry for compatible UI copy/actions. */
const RESOURCE_MANAGED_BY_PLATFORM = 'RESOURCE_MANAGED_BY_PLATFORM';

const normalizeEnterpriseErrorCode = (code: string): string =>
  code === RESOURCE_MANAGED_BY_PLATFORM ? MANAGED_ERROR_CODES.MANAGED_RESOURCE_BY_PLATFORM : code;

const extractBody = (error: unknown): EnterpriseErrorBody | null => {
  if (!error || typeof error !== 'object') return null;

  // tRPC formatted: data.errorData
  const data = (error as { data?: { errorData?: unknown } }).data;
  if (data?.errorData && typeof data.errorData === 'object' && data.errorData) {
    const body = data.errorData as EnterpriseErrorBody;
    if (typeof body.code === 'string') {
      const code = normalizeEnterpriseErrorCode(body.code);
      if (isEnterpriseErrorCode(code)) return { ...body, code };
    }
  }

  // Raw TRPCError cause: { data: EnterpriseErrorBody }
  const cause = (error as { cause?: unknown }).cause;
  if (cause && typeof cause === 'object' && 'data' in cause) {
    const body = (cause as { data?: unknown }).data;
    if (body && typeof body === 'object' && 'code' in body) {
      const code = normalizeEnterpriseErrorCode(String((body as { code: unknown }).code));
      // Return the NORMALIZED code (matching the other extract branches) — otherwise a legacy
      // alias like RESOURCE_MANAGED_BY_PLATFORM survives un-normalized and fails the downstream
      // isEnterpriseErrorCode(body.code) check, dropping to fuzzy message matching.
      if (isEnterpriseErrorCode(code)) return { ...(body as EnterpriseErrorBody), code };
    }
  }

  // Nested shape used by some clients: error.json?.data?.errorData
  const json = (error as { json?: { data?: { errorData?: unknown } } }).json;
  if (json?.data?.errorData && typeof json.data.errorData === 'object') {
    const body = json.data.errorData as EnterpriseErrorBody;
    if (typeof body.code === 'string') {
      const code = normalizeEnterpriseErrorCode(body.code);
      if (isEnterpriseErrorCode(code)) return { ...body, code };
    }
  }

  return null;
};

/**
 * Map tRPC / enterprise errors to stable codes for UI.
 * Prefers structured `errorData` / `cause.data` (EnterpriseErrorBody);
 * falls back to free-text message matching for older callers.
 */
export const mapEnterpriseError = (error: unknown): MappedEnterpriseError | null => {
  const body = extractBody(error);
  if (body && isEnterpriseErrorCode(body.code)) {
    return {
      action: ACTION_BY_CODE[body.code] ?? 'none',
      code: body.code,
      details: body.details,
      i18nKey: `enterprise.error.${body.code}`,
    };
  }

  const message =
    typeof error === 'string'
      ? error
      : error && typeof error === 'object' && 'message' in error
        ? String((error as { message?: unknown }).message ?? '')
        : '';

  const codeCandidate = normalizeEnterpriseErrorCode(message.trim());
  if (!isEnterpriseErrorCode(codeCandidate)) return null;

  return {
    action: ACTION_BY_CODE[codeCandidate] ?? 'none',
    code: codeCandidate,
    i18nKey: `enterprise.error.${codeCandidate}`,
  };
};

/** Re-export catalogs for UI bindings. */
export { ADMIN_ERROR_CODES, ENTERPRISE_ERROR_CODES, MANAGED_ERROR_CODES, PLATFORM_ERROR_CODES };
