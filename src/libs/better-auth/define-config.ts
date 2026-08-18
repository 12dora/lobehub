import { expo } from '@better-auth/expo';
import { passkey } from '@better-auth/passkey';
import { BRANDING_NAME } from '@lobechat/business-const';
import { createNanoId, idGenerator, serverDB } from '@lobechat/database';
import * as schema from '@lobechat/database/schemas';
import { identityProviderAssertsVerifiedEmail } from '@lobechat/types';
import bcrypt from 'bcryptjs';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { verifyPassword as defaultVerifyPassword } from 'better-auth/crypto';
import { type BetterAuthOptions } from 'better-auth/minimal';
import { betterAuth } from 'better-auth/minimal';
import { admin, emailOTP, genericOAuth, magicLink, twoFactor } from 'better-auth/plugins';
import { type BetterAuthPlugin } from 'better-auth/types';
import { eq } from 'drizzle-orm';
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

import { appEnv } from '@/envs/app';
import { authEnv } from '@/envs/auth';
import {
  getChangeEmailVerificationTemplate,
  getMagicLinkEmailTemplate,
  getResetPasswordEmailTemplate,
  getVerificationEmailTemplate,
  getVerificationOTPEmailTemplate,
} from '@/libs/better-auth/email-templates';
import { emailWhitelist } from '@/libs/better-auth/plugins/email-whitelist';
import { registrationGuard } from '@/libs/better-auth/plugins/registration-guard';
import { initBetterAuthSSOProviders } from '@/libs/better-auth/sso';
import {
  buildPlatformIdentityProvider,
  enforcePlatformOidcGroupRoleMappingForUserAccounts,
  type RuntimeIdentityProvider,
} from '@/libs/better-auth/sso/platformIdentityProvider';
import { platformIdentityProviderState } from '@/libs/better-auth/sso/platformIdentityProviderState';
import { createSecondaryStorage, getTrustedOrigins } from '@/libs/better-auth/utils/config';
import { parseSSOProviders } from '@/libs/better-auth/utils/server';
import { EmailService } from '@/server/services/email';
import { UserService } from '@/server/services/user';

const LOCAL_NO_PROXY_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

export const mergeLocalNoProxy = (noProxy?: string): string => {
  const entries = new Set(
    (noProxy || '')
      .split(/[,\s]+/)
      .map((entry) => entry.trim())
      .filter(Boolean),
  );

  if (entries.has('*')) return '*';

  for (const host of LOCAL_NO_PROXY_HOSTS) {
    entries.add(host);
  }

  return [...entries].join(',');
};

// Configure HTTP proxy for OAuth provider requests in development (e.g., Google token exchange).
// Node.js native fetch doesn't respect system proxy settings. Keep localhost direct so Next can
// fetch local Vite templates such as /index.auth.html without depending on the system proxy.
// Ref: https://github.com/better-auth/better-auth/issues/7396
if (process.env.NODE_ENV === 'development') {
  const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy;
  const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy || httpProxy;

  if (httpProxy || httpsProxy) {
    const proxyAgent = new EnvHttpProxyAgent({
      ...(httpProxy && { httpProxy }),
      ...(httpsProxy && { httpsProxy }),
      noProxy: mergeLocalNoProxy(process.env.NO_PROXY || process.env.no_proxy),
    });
    setGlobalDispatcher(proxyAgent);
  }
}

// Email verification link expiration time (in seconds)
// Default is 1 hour (3600 seconds) as per Better Auth documentation
const VERIFICATION_LINK_EXPIRES_IN = 3600;

/**
 * Safely extract hostname from APP_URL for passkey rpID.
 * Returns undefined if APP_URL is not set (e.g., in e2e tests).
 */
const getPasskeyRpID = (): string | undefined => {
  if (!appEnv.APP_URL) return undefined;
  try {
    return new URL(appEnv.APP_URL).hostname;
  } catch {
    return undefined;
  }
};

/**
 * Get passkey origins array.
 * Returns undefined if APP_URL is not set (e.g., in e2e tests).
 */
const getPasskeyOrigins = (): string[] | undefined => {
  if (!appEnv.APP_URL) return undefined;
  try {
    return [new URL(appEnv.APP_URL).origin];
  } catch {
    return undefined;
  }
};
const MAGIC_LINK_EXPIRES_IN = 900;
// OTP expiration time (in seconds) - 5 minutes for mobile OTP verification
const OTP_EXPIRES_IN = 300;
const enableMagicLink = authEnv.AUTH_ENABLE_MAGIC_LINK;
interface CustomBetterAuthOptions {
  plugins: BetterAuthPlugin[];
}

export interface BetterAuthIdentitySnapshot {
  databaseProviders: RuntimeIdentityProvider[];
  providerIds: string[];
}

const environmentIdentitySnapshot = (): BetterAuthIdentitySnapshot => ({
  databaseProviders: [],
  providerIds: parseSSOProviders(authEnv.AUTH_SSO_PROVIDERS),
});

export function defineConfig(
  customOptions: CustomBetterAuthOptions,
  identitySnapshot: BetterAuthIdentitySnapshot = environmentIdentitySnapshot(),
) {
  // CRITICAL C3: skip disabled/tombstoned providers so a revoked IdP is not
  // offered at the better-auth config level (consistent with startup/LKG selection).
  const activeDatabaseProviders = identitySnapshot.databaseProviders.filter(
    (provider) => provider.enabled !== false,
  );
  const disabledProviderKeys = new Set(
    identitySnapshot.databaseProviders
      .filter((provider) => provider.enabled === false)
      .map((provider) => provider.providerKey),
  );
  const enabledSSOProviders = identitySnapshot.providerIds.filter(
    (providerId) => !disabledProviderKeys.has(providerId),
  );
  /**
   * Visible ≠ trusted-for-linking. A provider in `accountLinking.trustedProviders` may
   * implicitly attach its identity to an existing account that merely shares an email address
   * (better-auth `handleOAuthUserInfo`: `!isTrustedProvider && !userInfo.emailVerified` is the
   * only guard). Kinds that cannot assert a verified email — DingTalk usually returns none and
   * we synthesize one — must therefore stay out of that list: a DingTalk login always creates
   * or reuses its own account and can never take over a pre-existing one.
   */
  const untrustedForLinkingProviderKeys = new Set(
    activeDatabaseProviders
      .filter((provider) => !identityProviderAssertsVerifiedEmail(provider.type))
      .map((provider) => provider.providerKey),
  );
  const linkingTrustedProviders = enabledSSOProviders.filter(
    (providerId) => !untrustedForLinkingProviderKeys.has(providerId),
  );
  const databaseProviders = activeDatabaseProviders.map((provider) =>
    buildPlatformIdentityProvider(provider, appEnv.APP_URL ?? ''),
  );
  const { socialProviders, genericOAuthProviders } = initBetterAuthSSOProviders({
    additionalGenericOAuthProviders: databaseProviders,
  });
  const options = {
    account: {
      accountLinking: {
        allowDifferentEmails: true,
        enabled: true,
        trustedProviders: linkingTrustedProviders,
      },
      // OAuth state carries the per-login OIDC nonce hash. Database strategy makes it
      // shared across instances and consumes the verification row before token exchange.
      storeStateStrategy: 'database',
    },

    baseURL: appEnv.APP_URL,
    secret: authEnv.AUTH_SECRET,
    trustedOrigins: getTrustedOrigins(enabledSSOProviders),

    emailAndPassword: {
      autoSignIn: true,
      disableSignUp: authEnv.AUTH_DISABLE_EMAIL_PASSWORD,
      enabled: !authEnv.AUTH_DISABLE_EMAIL_PASSWORD,
      maxPasswordLength: 64,
      minPasswordLength: 8,
      requireEmailVerification: authEnv.AUTH_EMAIL_VERIFICATION,
      revokeSessionsOnPasswordReset: true,

      // Compatible with bcrypt password hashes migrated from Clerk; after login, you can re-hash in the backend using BetterAuth's default scrypt.
      password: {
        // New passwords continue to use BetterAuth's default hash to stay consistent with the official configuration.
        async verify({ hash, password }: { hash: string; password: string }): Promise<boolean> {
          if (!hash) return false;

          // Compatible with bcrypt hashes exported from Clerk (starting with $2a$ or $2b$)
          if (hash.startsWith('$2a$') || hash.startsWith('$2b$')) {
            return bcrypt.compare(password, hash);
          }

          // For all other cases, use BetterAuth's default verification
          return defaultVerifyPassword({ hash, password });
        },
      },

      sendResetPassword: async ({ user, url }) => {
        const emailService = await EmailService.create();
        await emailService.sendBrandedMail(({ branding }) => ({
          to: user.email,
          ...getResetPasswordEmailTemplate({
            appUrl: appEnv.APP_URL,
            legalName: branding.legalName,
            logoUrl: branding.logoUrl,
            platformName: branding.name,
            url,
          }),
        }));
      },
    },
    emailVerification: {
      autoSignInAfterVerification: true,
      expiresIn: VERIFICATION_LINK_EXPIRES_IN,
      sendVerificationEmail: async ({ user, url }, request) => {
        // Skip sending verification link email for mobile clients (Expo/React Native)
        // Mobile clients use OTP verification instead, triggered manually via emailOTP plugin
        if (request?.headers?.get?.('x-client-type') === 'mobile') {
          return;
        }

        // Use different template for change-email vs signup verification
        const isChangeEmail = request?.url?.includes('/change-email');
        const emailService = await EmailService.create();
        await emailService.sendBrandedMail(({ branding }) => ({
          to: user.email,
          ...(isChangeEmail
            ? getChangeEmailVerificationTemplate({
                appUrl: appEnv.APP_URL,
                expiresInSeconds: VERIFICATION_LINK_EXPIRES_IN,
                legalName: branding.legalName,
                logoUrl: branding.logoUrl,
                platformName: branding.name,
                url,
                userName: user.name,
              })
            : getVerificationEmailTemplate({
                appUrl: appEnv.APP_URL,
                expiresInSeconds: VERIFICATION_LINK_EXPIRES_IN,
                legalName: branding.legalName,
                logoUrl: branding.logoUrl,
                platformName: branding.name,
                url,
                userName: user.name,
              })),
        }));
      },
    },
    onAPIError: {
      errorURL: '/auth-error',
    },
    session: {
      cookieCache: {
        enabled: true,
        maxAge: 2 * 60, // Cache duration in seconds
      },
      // Keep a DB-backed fallback when Redis secondary storage entries are unexpectedly missing.
      storeSessionInDatabase: true,
    },
    database: drizzleAdapter(serverDB, {
      provider: 'pg',
      // experimental joins feature needs schema to pass full relation
      schema,
    }),
    secondaryStorage: createSecondaryStorage(),
    /**
     * Database joins is useful when Better-Auth needs to fetch related data from multiple tables in a single query.
     * Endpoints like /get-session, /get-full-organization and many others benefit greatly from this feature,
     * seeing upwards of 2x to 3x performance improvements depending on database latency.
     * Ref: https://www.better-auth.com/docs/adapters/drizzle#joins-experimental
     */
    experimental: { joins: true },
    /**
     * Run user bootstrap for every newly created account (email, magic link, OAuth/social, etc.).
     * Using Better Auth database hooks ensures we catch social flows that bypass /sign-up/* routes.
     * Ref: https://www.better-auth.com/docs/reference/options#databasehooks
     */
    databaseHooks: {
      session: {
        create: {
          /**
           * Pre-session boundary for IdP group→role mapping (identity/F2).
           * Better Auth `create.after` runs after the row is committed (queueAfterTransactionHook),
           * so a swallowed failure there can leave an authenticated over-privileged session.
           * `create.before` returning false aborts session creation fail-closed.
           */
          before: async (session) => {
            // Idempotent repair: signup may have failed to grant platform_user
            // (DB-004). Never blocks the session — errors stay non-blocking.
            try {
              const { ensureDefaultPlatformUserRole } =
                await import('@/database/models/platform/ensureDefaultRole');
              await ensureDefaultPlatformUserRole(serverDB, session.userId);
            } catch {
              // ignore — session creation must proceed
            }

            const linked = await serverDB
              .select({
                accountId: schema.account.accountId,
                providerId: schema.account.providerId,
              })
              .from(schema.account)
              .where(eq(schema.account.userId, session.userId));
            try {
              await enforcePlatformOidcGroupRoleMappingForUserAccounts({
                accounts: linked,
                db: serverDB,
                userId: session.userId,
              });
            } catch {
              // Configured mapping present but demotion/apply failed — deny the session.
              return false;
            }
            return { data: session };
          },
        },
      },
      user: {
        create: {
          after: async (user) => {
            const userService = new UserService(serverDB);
            await userService.initUser({
              email: user.email,
              id: user.id,
              username: user.username as string | null,
              createdAt: user.createdAt,
              // TODO: if add phone plugin, we should fill phone here
            });
            // Authentik-only admission: grant platform_user when user has no global roles.
            // Never blocks account creation (errors are swallowed inside the helper).
            try {
              const { ensureDefaultPlatformUserRole } =
                await import('@/database/models/platform/ensureDefaultRole');
              await ensureDefaultPlatformUserRole(serverDB, user.id);
            } catch {
              // ignore — login/signup must succeed even if RBAC seed fails
            }
          },
        },
      },
    },
    user: {
      changeEmail: {
        enabled: true,
      },
      additionalFields: {
        dingtalkTitle: {
          input: false,
          required: false,
          returned: false,
          type: 'string',
        },
        dingtalkUserId: {
          input: false,
          required: false,
          returned: false,
          type: 'string',
        },
        username: {
          required: false,
          type: 'string',
        },
      },
      fields: {
        image: 'avatar',
        // NOTE: use drizzle filed instead of db field, so use fullName instead of full_name
        name: 'fullName',
      },
      modelName: 'users',
    },

    socialProviders,
    advanced: {
      // Optional per-instance cookie namespace (AUTH_COOKIE_PREFIX): lets multiple
      // deployments on the same host coexist in the port-blind browser cookie jar.
      // When unset, the key is omitted so Better Auth keeps its default names.
      ...(authEnv.AUTH_COOKIE_PREFIX ? { cookiePrefix: authEnv.AUTH_COOKIE_PREFIX } : {}),
      database: {
        /**
         * Align Better Auth user IDs with our shared idGenerator for consistency.
         * Other models use the shared nanoid generator (12 chars) to keep IDs consistent project-wide.
         */
        generateId: ({ model }) => {
          // Better Auth passes the model name; handle both singular and plural for safety.
          if (model === 'user' || model === 'users') {
            // clerk id length is 32
            return idGenerator('user', 32 - 'user_'.length);
          }

          // Other models: use shared nanoid generator (12 chars) to keep consistency.
          return createNanoId(12)();
        },
      },
    },
    rateLimit: {
      customRules: {
        // The passkey ceremony is bound to a server-issued challenge, so only the
        // challenge-minting endpoint is worth throttling.
        '/passkey/generate-authenticate-options': { max: 10, window: 60 },
        '/request-password-reset': { max: 3, window: 60 },
        '/send-verification-email': { max: 3, window: 60 },
        // Second-factor guessing: a 6-digit TOTP and a backup code are both small enough
        // search spaces that an unthrottled endpoint is the weakest link in the whole flow.
        '/two-factor/disable': { max: 5, window: 60 },
        '/two-factor/enable': { max: 5, window: 60 },
        '/two-factor/verify-backup-code': { max: 5, window: 60 },
        '/two-factor/verify-totp': { max: 5, window: 60 },
      },
    },
    plugins: [
      ...customOptions.plugins,
      emailWhitelist(),
      registrationGuard(),
      expo(),
      admin(),
      // Email OTP plugin for mobile verification / existing-user sign-in.
      // disableSignUp: OTP must not self-provision accounts — registration policy
      // (registrationGuard) + admin/SSO cover account creation. Defense in depth:
      // even if a future path bypasses the create hook, email-otp will not createUser.
      emailOTP({
        disableSignUp: true,
        expiresIn: OTP_EXPIRES_IN,
        otpLength: 6,
        allowedAttempts: 3,
        // Don't automatically send OTP on sign up - let mobile client manually trigger it
        sendVerificationOnSignUp: false,
        async sendVerificationOTP({ email, otp }) {
          const emailService = await EmailService.create();

          // For all OTP types, use the same template
          // userName is optional and will be null since we don't have user context here
          await emailService.sendBrandedMail(({ branding }) => ({
            to: email,
            ...getVerificationOTPEmailTemplate({
              appUrl: appEnv.APP_URL,
              expiresInSeconds: OTP_EXPIRES_IN,
              legalName: branding.legalName,
              logoUrl: branding.logoUrl,
              otp,
              platformName: branding.name,
              userName: null,
            }),
          }));
        },
      }),
      // Two documented second factors: an authenticator app (TOTP) and a passkey. OTP-over-email
      // is deliberately left off — it would make the recovery channel (the mailbox) the factor.
      // Backup codes stay on as the account-recovery path.
      twoFactor({
        // The issuer shown inside the authenticator app. Like `passkey.rpName` below this is
        // captured at startup, so it is the build-time brand; the enrolment UI rewrites the
        // otpauth label with the runtime brand before rendering the QR code.
        issuer: BRANDING_NAME,
        // Leave `twoFactorEnabled` false until a code from the authenticator is accepted,
        // so a user who scans the QR and walks away is not locked out of their own account.
        skipVerificationOnEnable: false,
      }),
      passkey({
        // WebAuthn RP metadata is captured at Better Auth startup and intentionally does not hot-update.
        rpName: BRANDING_NAME,
        // Extract rpID from auth URL (e.g., 'lobehub.com' from 'https://lobehub.com')
        // Returns undefined if AUTH_URL is not set (e.g., in e2e tests)
        rpID: getPasskeyRpID(),
        // Support multiple origins: web + Android APK key hashes
        // Android origin format: android:apk-key-hash:<base64url-sha256-fingerprint>
        // Returns undefined if AUTH_URL is not set (e.g., in e2e tests)
        origin: getPasskeyOrigins(),
      }),
      ...(databaseProviders.length > 0
        ? [platformIdentityProviderState(databaseProviders.map((provider) => provider.providerId))]
        : []),
      ...(genericOAuthProviders.length > 0
        ? [
            genericOAuth({
              config: genericOAuthProviders,
            }),
          ]
        : []),
      ...(enableMagicLink
        ? [
            magicLink({
              expiresIn: MAGIC_LINK_EXPIRES_IN,
              sendMagicLink: async ({ email, url }) => {
                const emailService = await EmailService.create();
                await emailService.sendBrandedMail(({ branding }) => ({
                  to: email,
                  ...getMagicLinkEmailTemplate({
                    appUrl: appEnv.APP_URL,
                    expiresInSeconds: MAGIC_LINK_EXPIRES_IN,
                    legalName: branding.legalName,
                    logoUrl: branding.logoUrl,
                    platformName: branding.name,
                    url,
                  }),
                }));
              },
            }),
          ]
        : []),
    ],
  } satisfies BetterAuthOptions;

  return betterAuth(options);
}
