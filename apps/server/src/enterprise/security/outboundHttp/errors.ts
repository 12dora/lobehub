import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';

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

export const ssrfBlocked = (reason: string, details?: Record<string, unknown>) =>
  new SafeOutboundHttpError(`SSRF blocked: ${reason}`, details);
