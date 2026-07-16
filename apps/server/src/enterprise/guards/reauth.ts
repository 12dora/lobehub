/**
 * Recent reauthentication guard for high-risk admin mutations (M04).
 * M13 may harden window policy / step-up flows; keep this boundary small.
 *
 * Trust only server-propagated auth metadata (session createdAt / OIDC iat).
 * Never read client timestamps or reauth headers.
 */
import { ADMIN_ERROR_CODES } from '@/const/platform/errorCodes';
import type { AuthMethod } from '@/libs/trpc/lambda/context';

import { ADMIN_REAUTH_MAX_AGE_MS } from '../contracts/adminUsers';
import { throwEnterpriseError } from './enterpriseErrors';

export interface ReauthContext {
  authenticatedAt?: Date | null;
  authMethod?: AuthMethod | null;
}

/**
 * Assert the principal has a recent interactive authentication signal.
 * API keys and missing/stale authenticatedAt → ADMIN_REAUTH_REQUIRED.
 */
export const assertRecentReauth = (
  ctx: ReauthContext,
  maxAgeMs: number = ADMIN_REAUTH_MAX_AGE_MS,
): void => {
  if (ctx.authMethod === 'api-key') {
    throwEnterpriseError({
      code: ADMIN_ERROR_CODES.ADMIN_REAUTH_REQUIRED,
      details: { reason: 'api_key_not_interactive' },
      httpCode: 'UNAUTHORIZED',
    });
  }

  const at = ctx.authenticatedAt;
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    return throwEnterpriseError({
      code: ADMIN_ERROR_CODES.ADMIN_REAUTH_REQUIRED,
      details: { reason: 'missing_authenticated_at' },
      httpCode: 'UNAUTHORIZED',
    });
  }

  const age = Date.now() - at.getTime();
  if (age < 0 || age > maxAgeMs) {
    return throwEnterpriseError({
      code: ADMIN_ERROR_CODES.ADMIN_REAUTH_REQUIRED,
      details: { reason: 'stale_authenticated_at' },
      httpCode: 'UNAUTHORIZED',
    });
  }
};
