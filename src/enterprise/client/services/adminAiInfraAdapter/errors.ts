import { toast } from '@lobehub/ui/base-ui';
import i18n from 'i18next';

import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import {
  AdminReauthBlockedError,
  AdminReauthCancelledError,
} from '@/enterprise/client/features/admin/reauth/requestAdminReauth';

const t = (key: string, options?: Record<string, unknown>) =>
  String(i18n.t(key as never, { ns: 'admin', ...options }));

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

  const message =
    cause instanceof Error && cause.message
      ? cause.message.slice(0, 200)
      : typeof cause === 'string'
        ? cause.slice(0, 200)
        : fallback;
  toast.error(message || fallback);
};

/** Wrap an async write so failures toast without swallowing the rejection. */
export const withAdminAiInfraErrorToast = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (error) {
    notifyAdminAiInfraError(error);
    throw error;
  }
};
