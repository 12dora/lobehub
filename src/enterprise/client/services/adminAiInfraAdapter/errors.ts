import { toast } from '@lobehub/ui/base-ui';

import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import {
  AdminReauthBlockedError,
  AdminReauthCancelledError,
} from '@/enterprise/client/features/admin/reauth/requestAdminReauth';

/**
 * Map admin AiInfra write failures to a short user-visible toast.
 * Never includes secret material; uses enterprise error codes when present.
 */
export const notifyAdminAiInfraError = (cause: unknown, fallback = 'Save failed'): void => {
  if (cause instanceof AdminReauthCancelledError) {
    toast.error('Re-authentication cancelled');
    return;
  }
  if (cause instanceof AdminReauthBlockedError) {
    toast.error('Re-authentication unavailable for this session');
    return;
  }

  const mapped = mapEnterpriseError(cause);
  if (mapped?.code === 'ADMIN_REAUTH_REQUIRED' || mapped?.action === 'reauth') {
    toast.error('Re-authentication required');
    return;
  }
  if (
    mapped?.code === 'ADMIN_RATE_LIMITED' ||
    /429|rate.?limit|ADMIN_RATE_LIMITED/i.test(String(cause))
  ) {
    toast.error('Too many admin actions — try again shortly');
    return;
  }
  if (mapped?.code === 'PLATFORM_CONFIG_VALIDATION_FAILED') {
    const issueCount =
      mapped.details && typeof mapped.details === 'object' && 'issueCount' in mapped.details
        ? Number((mapped.details as { issueCount?: number }).issueCount)
        : undefined;
    toast.error(
      issueCount
        ? `Validation failed (${issueCount} issue${issueCount === 1 ? '' : 's'})`
        : 'Validation failed — draft kept, not published',
    );
    return;
  }
  if (mapped?.i18nKey) {
    toast.error(mapped.code || fallback);
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
