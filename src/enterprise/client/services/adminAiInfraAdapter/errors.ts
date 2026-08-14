import { toast } from '@lobehub/ui/base-ui';
import debug from 'debug';
import i18n from 'i18next';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import {
  AdminReauthBlockedError,
  AdminReauthCancelledError,
} from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import type { EnterpriseErrorBody } from '@/types/platform/errors';

const log = debug('lobe-client:admin:ai-infra');

const t = (key: string, options?: Record<string, unknown>) =>
  String(i18n.t(key as never, { ns: 'admin', ...options }));

/**
 * Typed partial-load failure for admin provider detail batch fetches.
 * Shape matches mapEnterpriseError's tRPC `data.errorData` extraction path.
 */
export const createAdminAiProviderPartialLoadError = (failedKeys: string[]): Error => {
  const unique = [...new Set(failedKeys.filter(Boolean))];
  const body: EnterpriseErrorBody = {
    code: PLATFORM_ERROR_CODES.PLATFORM_AI_PROVIDER_PARTIAL_LOAD,
    details: { count: unique.length },
    message: PLATFORM_ERROR_CODES.PLATFORM_AI_PROVIDER_PARTIAL_LOAD,
  };
  const error = new Error(PLATFORM_ERROR_CODES.PLATFORM_AI_PROVIDER_PARTIAL_LOAD);
  Object.assign(error, { data: { errorData: body } });
  return error;
};

/**
 * Map admin AiInfra write failures to a short user-visible toast.
 * Never includes secret material; uses enterprise error codes when present.
 */
export const notifyAdminAiInfraError = (
  cause: unknown,
  fallbackKey = 'aiInfraError.saveFailed',
): void => {
  const fallback = t(fallbackKey);
  if (cause instanceof AdminReauthCancelledError) {
    toast.error(t('aiInfraError.reauthCancelled'));
    return;
  }
  if (cause instanceof AdminReauthBlockedError) {
    toast.error(t('aiInfraError.reauthUnavailable'));
    return;
  }

  const mapped = mapEnterpriseError(cause);
  if (mapped?.code === 'ADMIN_REAUTH_REQUIRED' || mapped?.action === 'reauth') {
    toast.error(t('aiInfraError.reauthRequired'));
    return;
  }
  if (
    mapped?.code === 'ADMIN_RATE_LIMITED' ||
    /429|rate.?limit|ADMIN_RATE_LIMITED/i.test(String(cause))
  ) {
    toast.error(t('aiInfraError.rateLimited'));
    return;
  }
  if (mapped?.code === 'PLATFORM_CONFIG_VALIDATION_FAILED') {
    const issueCount =
      mapped.details && typeof mapped.details === 'object' && 'issueCount' in mapped.details
        ? Number((mapped.details as { issueCount?: number }).issueCount)
        : undefined;
    toast.error(
      issueCount
        ? t('aiInfraError.validationFailedCount', { count: issueCount })
        : t('aiInfraError.validationFailed'),
    );
    return;
  }
  if (mapped?.i18nKey) {
    // enterprise.error.* keys live in the admin namespace; fall back to the localized default.
    // Only forward allowlisted interpolation keys — never spread raw details into i18next
    // options (a detail named defaultValue/lng/ns/… could override translation behavior).
    const details =
      mapped.details && typeof mapped.details === 'object'
        ? (mapped.details as Record<string, unknown>)
        : {};
    const interpolation: Record<string, unknown> = {};
    if (typeof details.max === 'number' || typeof details.max === 'string') {
      interpolation.max = details.max;
    }
    if (typeof details.count === 'number' || typeof details.count === 'string') {
      interpolation.count = details.count;
    }
    if (typeof details.issueCount === 'number' || typeof details.issueCount === 'string') {
      interpolation.issueCount = details.issueCount;
    }
    toast.error(t(mapped.i18nKey, { defaultValue: fallback, ...interpolation }));
    return;
  }

  // Never surface raw exception / transport text to admins (XT-007 / AI-10).
  log('unmapped ai-infra write failure: %O', cause);
  toast.error(fallback);
};

/**
 * Marker set on errors after `withAdminAiInfraErrorToast` has already shown a
 * user-facing toast. Adapter catches check this to avoid double-toasting when a
 * pre-read or local guard needs its own failure path.
 */
export const ADMIN_AI_INFRA_ERROR_TOASTED = Symbol.for('lobe.adminAiInfraErrorToasted');

export const isAdminAiInfraErrorToasted = (err: unknown): boolean =>
  Boolean(
    err &&
    typeof err === 'object' &&
    (err as Record<PropertyKey, unknown>)[ADMIN_AI_INFRA_ERROR_TOASTED] === true,
  );

const markToasted = (error: unknown): void => {
  if (!error || typeof error !== 'object') return;
  Object.defineProperty(error, ADMIN_AI_INFRA_ERROR_TOASTED, {
    configurable: true,
    enumerable: false,
    value: true,
    writable: false,
  });
};

/**
 * Toast one already-collected failure, mark it, and rethrow.
 *
 * For multi-write operations (provider reorder) that must attempt EVERY write: the individual
 * calls run untoasted so N failures cannot produce N toasts, then the caller reports exactly one.
 */
export const reportAdminAiInfraError = (cause: unknown): never => {
  notifyAdminAiInfraError(cause);
  markToasted(cause);
  throw cause;
};

/** Wrap an async write so failures toast without swallowing the rejection. */
export const withAdminAiInfraErrorToast = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (error) {
    notifyAdminAiInfraError(error);
    markToasted(error);
    throw error;
  }
};
