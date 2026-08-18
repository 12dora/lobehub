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
import { readEnterpriseErrorBodies } from '@/utils/enterpriseErrorBody';

export interface MappedEnterpriseError {
  /** Suggested UX action for shared handlers. */
  action: 'signin' | 'reauth' | 'retry' | 'contact_admin' | 'none';
  code: EnterpriseErrorCode;
  details?: EnterpriseErrorBody['details'];
  i18nKey: string;
}

const ACTION_BY_CODE: Partial<Record<EnterpriseErrorCode, MappedEnterpriseError['action']>> = {
  // A request that hit a module the deployment switched off. Retrying, re-authenticating or
  // contacting an admin all miss the point; the code's own copy says what happened, and the UI
  // degradation (hidden nav + AdminModuleDisabledSurface) carries the next step.
  [PLATFORM_ERROR_CODES.PLATFORM_MODULE_DISABLED]: 'none',
  [PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED]: 'contact_admin',
  [PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT]: 'retry',
  [PLATFORM_ERROR_CODES.PLATFORM_RESOURCE_IN_USE]: 'retry',
  [PLATFORM_ERROR_CODES.PLATFORM_AGENT_DEPENDENCY_UNAVAILABLE]: 'contact_admin',
  [PLATFORM_ERROR_CODES.PLATFORM_AGENT_START_FAILED]: 'retry',
  [PLATFORM_ERROR_CODES.PLATFORM_AGENT_UNAVAILABLE]: 'retry',
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

/**
 * First body whose code the catalog recognises, across the transport shapes
 * (`data.errorData`, a raw `TRPCError`'s `cause.data`, `json.data.errorData`).
 *
 * The walk itself lives in the core-safe `readEnterpriseErrorBodies`, shared with the
 * presentation surfaces that may not import this layer — one place decides where a server
 * error keeps its code, message and details.
 *
 * Codes are NORMALIZED before the check, so a legacy alias like RESOURCE_MANAGED_BY_PLATFORM
 * cannot survive un-normalized and drop the caller to fuzzy message matching.
 */
const extractBody = (error: unknown): EnterpriseErrorBody | null => {
  for (const body of readEnterpriseErrorBodies(error)) {
    if (!body.code) continue;
    const code = normalizeEnterpriseErrorCode(body.code);
    if (isEnterpriseErrorCode(code)) return { ...body, code };
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
    if (body.code === PLATFORM_ERROR_CODES.PLATFORM_GLOBAL_CREDENTIAL_FILE_PAYLOAD_INVALID) {
      return {
        action: 'none',
        code: body.code,
        details: body.details,
        i18nKey: 'globalCredentials.validation.filePayloadInvalid',
      };
    }
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
