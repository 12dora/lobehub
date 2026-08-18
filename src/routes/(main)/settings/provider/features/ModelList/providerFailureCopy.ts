import type { TFunction } from 'i18next';

import { readEnterpriseErrorBody } from '@/utils/enterpriseErrorBody';
import { getStructuredPlatformErrorCode } from '@/utils/platformErrorCode';

import { connectionFailureReasonKey } from '../ProviderConfig/connectionFailureCopy';

export interface ProviderFailureBody {
  code?: string;
  details?: {
    errorCategory?: string;
    errorType?: string;
    issueCount?: number;
    reason?: string;
  };
  message?: string;
}

const readString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/**
 * The parts of the server's error body the model-list toasts read. Everything on it is a
 * STABLE code — `code`, `details.reason`, `details.errorType`, and `message`
 * (`connection_failed_*`, or the enterprise code itself) — so it is routed to copy and never
 * rendered, which is what made an operator read `同步失败：PLATFORM_CONFIG_VALIDATION_FAILED`.
 *
 * The walk over the transport shapes is the shared, core-safe `readEnterpriseErrorBody`, the
 * same one `mapEnterpriseError` uses: these panels may not import the enterprise client layer
 * (the reason `getStructuredPlatformErrorCode` exists), but they must not disagree with it
 * about where a server error keeps its body either. Only the narrowing of the fields these
 * toasts read is local.
 */
export const readProviderFailureBody = (error: unknown): ProviderFailureBody => {
  const body = readEnterpriseErrorBody(error);
  if (!body) return {};

  const details = body.details;

  return {
    code: body.code,
    details: details && {
      errorCategory: readString(details.errorCategory),
      errorType: readString(details.errorType),
      issueCount: typeof details.issueCount === 'number' ? details.issueCount : undefined,
      reason: readString(details.reason),
    },
    message: body.message,
  };
};

/**
 * A machine token rather than a sentence: `PLATFORM_CONFIG_VALIDATION_FAILED`,
 * `connection_failed_auth`, `MANAGED_RESOURCE_BY_PLATFORM`. Provider prose ("model list is
 * not available for this account") always carries spaces or punctuation, so it survives.
 */
const isStableCode = (value: string): boolean => /^[A-Z][\dA-Z]*(?:_[\dA-Z]+)+$/i.test(value);

/**
 * Cause line for a failed BYOK model-list fetch.
 *
 * The upstream's own words are the most actionable thing the user can read, so they are kept
 * — but only when they ARE words. A server-side refusal answers with a stable code, and a
 * code rendered into a toast tells the user nothing they can act on.
 */
export const resolveFetchFailureMessage = (
  error: unknown,
  t: TFunction<'modelProvider'>,
  tSetting: TFunction<'setting'>,
): string => {
  const body = readProviderFailureBody(error);

  const reasonKey = connectionFailureReasonKey({
    errorCategory: body.details?.errorCategory,
    errorType: body.details?.errorType,
    message: body.message,
  });
  if (reasonKey) return tSetting(reasonKey as never);

  const raw = error instanceof Error ? error.message.trim() : '';
  const isPlatformRefusal = Boolean(body.message) || !!getStructuredPlatformErrorCode(error);
  if (raw && !isPlatformRefusal && !isStableCode(raw)) return raw;

  return t('providerModels.list.fetcher.errorFallback');
};
