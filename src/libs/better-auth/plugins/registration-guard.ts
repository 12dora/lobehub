import { getCurrentAuthContext } from '@better-auth/core/context';
import { isReservedSyntheticIdentityEmail } from '@lobechat/types';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { type BetterAuthPlugin } from 'better-auth/types';
import debug from 'debug';

import { PlatformAuthSettingsModel } from '@/database/models/platform';
import { getServerDB } from '@/database/server';
import { isEmailDomainAllowed, type PlatformAuthSettings } from '@/types/platform/authSettings';

const log = debug('lobe-server:auth:registration-guard');

/**
 * Documented self-service endpoints that create a user without admin/SSO approval.
 * The create hook is **deny-by-default** for any non-exempt path — this set is the
 * known create-capable surface (tests assert coverage) and is not the allow gate.
 *
 * better-auth 1.6.15 + registered plugins:
 * - `/sign-up/email` (core)
 * - `/magic-link/verify` (magicLink)
 * - `/sign-in/email-otp` (emailOTP when disableSignUp is false)
 */
export const SELF_SERVICE_SIGNUP_PATHS = new Set([
  '/sign-up/email',
  '/magic-link/verify',
  '/sign-in/email-otp',
]);

/**
 * Request paths that need early policy checks before a magic-link / OTP is issued.
 * Existing users may still request sign-in when registration is closed.
 */
export const SELF_SERVICE_REQUEST_PATHS = new Set([
  '/sign-up/email',
  '/sign-in/magic-link',
  '/email-otp/send-verification-otp',
]);

/**
 * Exact paths allowed to create users without the admin-managed registration policy.
 * Prefer this over expanding a self-service allowlist when adding admin tooling.
 */
export const USER_CREATE_POLICY_EXEMPT_PATHS = new Set(['/admin/create-user']);

type AuthPathContext = { path?: string | null };

/**
 * Whether this request path may create users without registration-policy checks.
 * Covers admin create-user and OAuth/SSO callbacks (provider id is path suffix).
 */
export const isUserCreatePolicyExemptPath = (path: string | null | undefined): boolean => {
  if (typeof path !== 'string' || path.length === 0) return false;
  if (USER_CREATE_POLICY_EXEMPT_PATHS.has(path)) return true;
  // better-auth social / generic-oauth callbacks: `/callback/:id`, `/oauth2/callback/:providerId`
  if (path.startsWith('/callback/')) return true;
  if (path.startsWith('/oauth2/callback/')) return true;
  return false;
};

/**
 * Load admin-managed registration settings. Fail closed when the policy store is
 * unavailable — a table-level read failure does not imply the user insert will fail.
 */
export const loadRegistrationSettings = async (): Promise<PlatformAuthSettings> => {
  try {
    const db = await getServerDB();
    return await new PlatformAuthSettingsModel(db).get();
  } catch (error) {
    const errorClass = error instanceof Error ? error.constructor.name : 'unknown';
    log('registration policy read failed: %s', errorClass);
    throw new APIError('SERVICE_UNAVAILABLE', {
      code: 'REGISTRATION_POLICY_UNAVAILABLE',
      message: 'REGISTRATION_POLICY_UNAVAILABLE',
    });
  }
};

/**
 * Enforce open-registration + domain allowlist for a candidate self-service email.
 * Throws APIError with a stable code on denial.
 */
/**
 * The synthetic-identity email namespace belongs to the platform, not to self-service sign-up.
 * Without this a local account could pre-claim `<unionId>@<providerKey>.dingtalk.sso` and wait
 * for the matching SSO identity to arrive. OAuth/SSO callbacks are exempt from this hook, so
 * the providers that legitimately mint these addresses are unaffected.
 *
 * Unlike the open-registration / allowlist rules this is NOT waived for an existing user.
 */
export const assertNonReservedIdentityEmail = (email: string): void => {
  if (!isReservedSyntheticIdentityEmail(email)) return;
  throw new APIError('FORBIDDEN', {
    code: 'EMAIL_NOT_ALLOWED',
    message: 'EMAIL_NOT_ALLOWED',
  });
};

export const enforceRegistrationPolicy = (email: string, settings: PlatformAuthSettings): void => {
  assertNonReservedIdentityEmail(email);

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
};

/**
 * Whether this request path is a known self-service account-creation boundary.
 * Prefer `isUserCreatePolicyExemptPath` + deny-by-default for enforcement; this
 * helper remains for documentation and regression tests.
 */
export const isSelfServiceSignupPath = (path: string | null | undefined): boolean =>
  typeof path === 'string' && SELF_SERVICE_SIGNUP_PATHS.has(path);

const emailFromBody = (body: unknown): string => {
  if (!body || typeof body !== 'object') return '';
  const email = (body as { email?: unknown }).email;
  return typeof email === 'string' ? email : '';
};

/**
 * Allow existing users through when closed/allowlist would otherwise reject;
 * rethrow for first-time identities that would create an account.
 */
const allowExistingUserOrEnforce = async (
  email: string,
  settings: PlatformAuthSettings,
  findUserByEmail: ((email: string) => Promise<{ user?: unknown } | null>) | undefined,
): Promise<void> => {
  // Never waived by the existing-user escape hatch below.
  assertNonReservedIdentityEmail(email);
  try {
    enforceRegistrationPolicy(email, settings);
  } catch (error) {
    if (!(error instanceof APIError)) throw error;
    if (error.body?.code !== 'REGISTRATION_CLOSED' && error.body?.code !== 'EMAIL_NOT_ALLOWED') {
      throw error;
    }

    const existing = email && findUserByEmail ? await findUserByEmail(email) : null;
    if (existing?.user) return;

    throw error;
  }
};

/**
 * Runtime enforcement of the admin-managed registration policy at every
 * self-service user-creation boundary:
 *
 * 1. Request middleware on signup / magic-link / email-OTP send for early rejection.
 * 2. `databaseHooks.user.create.before` is **deny-by-default** for any request path
 *    that is not explicitly exempt (admin create-user, OAuth callbacks). Unknown
 *    plugin endpoints that call `createUser` fail closed without a path allowlist update.
 *
 * Existing-user magic-link / OTP sign-in is allowed even when registration is closed:
 * the request middleware looks up the user before applying closed/allowlist rules.
 * Admin-created and OAuth-provisioned users hit exempt paths or no request context.
 */
export const registrationGuard = (): BetterAuthPlugin => ({
  hooks: {
    before: [
      {
        handler: createAuthMiddleware(async (ctx) => {
          const path = ctx.path;
          const email = emailFromBody(ctx.body);

          const settings = await loadRegistrationSettings();

          // Email/password sign-up always creates a user — enforce unconditionally.
          if (path === '/sign-up/email') {
            enforceRegistrationPolicy(email, settings);
            return;
          }

          // Magic-link request and email-OTP send: allow existing users when
          // registration is closed; reject only when a brand-new account would
          // be created later (verify / sign-in/email-otp).
          if (path === '/sign-in/magic-link' || path === '/email-otp/send-verification-otp') {
            await allowExistingUserOrEnforce(email, settings, (candidate) =>
              ctx.context.internalAdapter.findUserByEmail(candidate),
            );
          }
        }),
        matcher: (ctx) => typeof ctx.path === 'string' && SELF_SERVICE_REQUEST_PATHS.has(ctx.path),
      },
    ],
  },
  id: 'registration-guard',
  init() {
    return {
      options: {
        databaseHooks: {
          user: {
            create: {
              before: async (user, context) => {
                let path = (context as AuthPathContext | null | undefined)?.path;
                if (!path) {
                  try {
                    path = (await getCurrentAuthContext()).path;
                  } catch {
                    // No request context → admin/scripted create; leave alone.
                    return { data: user };
                  }
                }

                // Still no path after context resolution — treat as non-HTTP create.
                if (!path) return { data: user };

                // Explicit exemptions only (admin + OAuth). Every other HTTP path
                // that reaches createUser is policy-gated — future plugin endpoints fail closed.
                if (isUserCreatePolicyExemptPath(path)) {
                  return { data: user };
                }

                const email = typeof user.email === 'string' ? user.email : '';
                const settings = await loadRegistrationSettings();
                enforceRegistrationPolicy(email, settings);
                return { data: user };
              },
            },
          },
        },
      },
    };
  },
});
