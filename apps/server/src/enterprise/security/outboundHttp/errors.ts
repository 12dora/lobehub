import type { EnterpriseSsrfDenialCategory } from '@lobechat/observability-otel/modules/enterprise-platform';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';

import { observeEnterprisePlatformEvent } from '../../observability';

/**
 * SSRF / outbound policy violation.
 * Maps to PLATFORM_SSRF_BLOCKED for tRPC/HTTP surfaces.
 */
export class SafeOutboundHttpError extends Error {
  readonly code = PLATFORM_ERROR_CODES.PLATFORM_SSRF_BLOCKED;

  constructor(
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SafeOutboundHttpError';
  }
}

export const ssrfBlocked = (
  category: EnterpriseSsrfDenialCategory,
  reason: string,
  details?: Record<string, unknown>,
) => {
  const error = new SafeOutboundHttpError(`SSRF blocked: ${reason}`, details);
  try {
    observeEnterprisePlatformEvent({ category, type: 'ssrf_denial' });
  } catch {
    console.error('[safe-outbound-http] denial observation failed');
  }
  return error;
};
