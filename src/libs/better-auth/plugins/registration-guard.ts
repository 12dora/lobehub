import { APIError, createAuthMiddleware } from 'better-auth/api';
import { type BetterAuthPlugin } from 'better-auth/types';

import { PlatformAuthSettingsModel } from '@/database/models/platform';
import { getServerDB } from '@/database/server';
import { isEmailDomainAllowed } from '@/types/platform/authSettings';

/**
 * Runtime enforcement of the admin-managed registration policy, scoped to the
 * self-service email/password sign-up endpoint ONLY. It never affects admin-created
 * users or SSO logins — those creation paths never hit `/sign-up/email`.
 *
 * - open registration OFF  → reject with REGISTRATION_CLOSED
 * - domain allowlist ON     → reject a non-matching email with EMAIL_NOT_ALLOWED
 *
 * The policy lives in the `platform_auth_settings` singleton and is read at request
 * time (the Better Auth instance is frozen at startup, so a startup snapshot would
 * never reflect an admin toggle without a restart).
 */
export const registrationGuard = (): BetterAuthPlugin => ({
  hooks: {
    before: [
      {
        handler: createAuthMiddleware(async (ctx) => {
          const email = typeof ctx.body?.email === 'string' ? ctx.body.email : '';

          let settings;
          try {
            const db = await getServerDB();
            settings = await new PlatformAuthSettingsModel(db).get();
          } catch {
            // Fail open on a read error: sign-up writes to the same database, so an
            // unavailable DB fails the sign-up itself — never add a spurious rejection.
            return;
          }

          if (!settings.openRegistration) {
            throw new APIError('FORBIDDEN', {
              code: 'REGISTRATION_CLOSED',
              message: 'REGISTRATION_CLOSED',
            });
          }

          if (
            settings.emailDomainAllowlistEnabled &&
            !isEmailDomainAllowed(email, settings.emailDomainAllowlist)
          ) {
            throw new APIError('FORBIDDEN', {
              code: 'EMAIL_NOT_ALLOWED',
              message: 'EMAIL_NOT_ALLOWED',
            });
          }
        }),
        matcher: (ctx) => ctx.path === '/sign-up/email',
      },
    ],
  },
  id: 'registration-guard',
});
