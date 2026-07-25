import {
  ADMIN_ERROR_CODES,
  ENTERPRISE_ERROR_CODES,
  type EnterpriseErrorCode,
  isEnterpriseErrorCode,
  MANAGED_ERROR_CODES,
  PLATFORM_CONNECTOR_ERROR_CODES,
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
  [PLATFORM_ERROR_CODES.PLATFORM_RESOURCE_IN_USE]: 'retry',
  [PLATFORM_ERROR_CODES.PLATFORM_FEATURE_DISABLED]: 'none',
  [PLATFORM_ERROR_CODES.PLATFORM_LAST_SUPER_ADMIN]: 'none',
  [PLATFORM_ERROR_CODES.PLATFORM_AI_MODEL_NOT_PUBLISHED]: 'none',
  [PLATFORM_ERROR_CODES.PLATFORM_AI_PROVIDER_PARTIAL_LOAD]: 'retry',
  [ADMIN_ERROR_CODES.ADMIN_ACCESS_DENIED]: 'contact_admin',
  [ADMIN_ERROR_CODES.ADMIN_REAUTH_REQUIRED]: 'reauth',
  [ADMIN_ERROR_CODES.ADMIN_FEATURE_DISABLED]: 'none',
  [MANAGED_ERROR_CODES.MANAGED_RESOURCE_BY_PLATFORM]: 'contact_admin',
  [MANAGED_ERROR_CODES.MANAGED_SETTING_BY_ADMIN]: 'contact_admin',
  [MANAGED_ERROR_CODES.MANAGED_AGENT_BATCH_LIMIT]: 'none',
  // Connector admin / runtime failures — prefer reload/retry over silent generic fallback.
  [PLATFORM_CONNECTOR_ERROR_CODES.PLATFORM_CONNECTOR_NOT_FOUND]: 'retry',
  [PLATFORM_CONNECTOR_ERROR_CODES.PLATFORM_CONNECTOR_NOT_PUBLISHED]: 'contact_admin',
  [PLATFORM_CONNECTOR_ERROR_CODES.PLATFORM_CONNECTOR_RESOURCE_MISMATCH]: 'retry',
  [PLATFORM_CONNECTOR_ERROR_CODES.PLATFORM_CONNECTOR_RATE_LIMITED]: 'retry',
  [PLATFORM_CONNECTOR_ERROR_CODES.PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED]: 'contact_admin',
  [PLATFORM_CONNECTOR_ERROR_CODES.PLATFORM_CONNECTOR_SCOPE_NOT_ALLOWED]: 'contact_admin',
  [PLATFORM_CONNECTOR_ERROR_CODES.PLATFORM_CONNECTOR_TOOL_DENIED]: 'contact_admin',
  [PLATFORM_CONNECTOR_ERROR_CODES.PLATFORM_CONNECTOR_SSRF_BLOCKED]: 'contact_admin',
  [PLATFORM_CONNECTOR_ERROR_CODES.PLATFORM_CONNECTOR_SECRET_EXPOSURE_BLOCKED]: 'none',
  [PLATFORM_CONNECTOR_ERROR_CODES.PLATFORM_CONNECTOR_OAUTH_STATE_EXPIRED]: 'retry',
  [PLATFORM_CONNECTOR_ERROR_CODES.PLATFORM_CONNECTOR_OAUTH_STATE_INVALID]: 'retry',
  [PLATFORM_CONNECTOR_ERROR_CODES.PLATFORM_CONNECTOR_OAUTH_STATE_REPLAYED]: 'retry',
  [PLATFORM_CONNECTOR_ERROR_CODES.PLATFORM_CONNECTOR_BINDING_NOT_FOUND]: 'retry',
  [PLATFORM_CONNECTOR_ERROR_CODES.PLATFORM_CONNECTOR_BINDING_OWNERSHIP_MISMATCH]: 'contact_admin',
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

/** Stable skill-import reason codes returned as `details.reason` / error message. */
const isSkillImportReason = (value: string): boolean => /^skill_import_[a-z0-9_]+$/.test(value);

const skillImportI18nKey = (reason: string): string => `skillCatalog.import.error.${reason}`;

const readDetailsReason = (details: EnterpriseErrorBody['details']): string | undefined => {
  if (!details || typeof details !== 'object') return undefined;
  const reason = (details as { reason?: unknown }).reason;
  return typeof reason === 'string' ? reason : undefined;
};

/**
 * Map tRPC / enterprise errors to stable codes for UI.
 * Prefers structured `errorData` / `cause.data` (EnterpriseErrorBody);
 * falls back to free-text message matching for older callers.
 *
 * Skill import failures use enterprise codes (`PLATFORM_INVALID_INPUT` /
 * `PLATFORM_NOT_FOUND`) with a stable `details.reason` (`skill_import_*`).
 * Prefer the skill-import locale key so toasts never show the raw reason code.
 */
export const mapEnterpriseError = (error: unknown): MappedEnterpriseError | null => {
  const body = extractBody(error);
  if (body && isEnterpriseErrorCode(body.code)) {
    const reason = readDetailsReason(body.details);
    if (reason && isSkillImportReason(reason)) {
      return {
        action: ACTION_BY_CODE[body.code] ?? 'none',
        code: body.code,
        details: body.details,
        i18nKey: skillImportI18nKey(reason),
      };
    }
    // Legal-hold create: purge contention uses shared PLATFORM_RESOURCE_IN_USE code
    // with a domain-specific details.reason — map to hold-specific copy, not generic.
    if (
      body.code === PLATFORM_ERROR_CODES.PLATFORM_RESOURCE_IN_USE &&
      reason === 'purge_in_progress'
    ) {
      return {
        action: ACTION_BY_CODE[body.code] ?? 'retry',
        code: body.code,
        details: body.details,
        i18nKey: 'audit.legalHold.errors.purgeInProgress',
      };
    }
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

  const trimmed = message.trim();
  if (isSkillImportReason(trimmed)) {
    return {
      action: 'none',
      code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
      details: { reason: trimmed },
      i18nKey: skillImportI18nKey(trimmed),
    };
  }

  const codeCandidate = normalizeEnterpriseErrorCode(trimmed);
  if (!isEnterpriseErrorCode(codeCandidate)) return null;

  return {
    action: ACTION_BY_CODE[codeCandidate] ?? 'none',
    code: codeCandidate,
    i18nKey: `enterprise.error.${codeCandidate}`,
  };
};

/** Re-export catalogs for UI bindings. */
export {
  ADMIN_ERROR_CODES,
  ENTERPRISE_ERROR_CODES,
  MANAGED_ERROR_CODES,
  PLATFORM_CONNECTOR_ERROR_CODES,
  PLATFORM_ERROR_CODES,
};
