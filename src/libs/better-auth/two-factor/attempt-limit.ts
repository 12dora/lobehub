import { APIError, createAuthMiddleware } from 'better-auth/api';
import type { BetterAuthPlugin } from 'better-auth/types';

/**
 * Total guesses allowed against one 2FA challenge before it is burned.
 *
 * A TOTP code is six digits (1e6 possibilities). Eight attempts is 0.0008% of
 * that space — enough for a legitimate user to fat-finger a code twice, plus a
 * clock-skew miss, without giving a password-holding attacker a parallel spray.
 * After this the challenge is deleted so they must re-enter the password
 * (itself rate-limited) rather than wait out a window.
 */
export const TWO_FACTOR_MAX_ATTEMPTS = 8;

/** Matches better-auth's default `twoFactorCookieMaxAge` (10 minutes). */
export const TWO_FACTOR_ATTEMPT_WINDOW_SECONDS = 600;

export const TWO_FACTOR_ATTEMPT_LIMIT_PATHS = new Set([
  '/two-factor/verify-totp',
  '/two-factor/verify-backup-code',
]);

export const TWO_FACTOR_TOO_MANY_ATTEMPTS_CODE = 'TWO_FACTOR_TOO_MANY_ATTEMPTS';

export const TWO_FACTOR_TOO_MANY_ATTEMPTS_MESSAGE =
  'Too many two-factor attempts. Sign in with your password again to retry.';

const attemptKey = (challengeId: string) => `2fa-attempts:${challengeId}`;

export interface ConsumeTwoFactorAttemptParams {
  challengeId: string;
  increment: (key: string, ttlSeconds?: number) => Promise<number>;
  invalidate: () => Promise<void>;
  maxAttempts?: number;
}

export const consumeTwoFactorAttempt = async (
  params: ConsumeTwoFactorAttemptParams,
): Promise<{ allowed: boolean; count: number }> => {
  const maxAttempts = params.maxAttempts ?? TWO_FACTOR_MAX_ATTEMPTS;
  const count = await params.increment(
    attemptKey(params.challengeId),
    TWO_FACTOR_ATTEMPT_WINDOW_SECONDS,
  );

  if (count <= maxAttempts) return { allowed: true, count };

  await params.invalidate();
  return { allowed: false, count };
};

export const rejectTwoFactorTooManyAttempts = (): never => {
  throw new APIError('TOO_MANY_REQUESTS', {
    code: TWO_FACTOR_TOO_MANY_ATTEMPTS_CODE,
    message: TWO_FACTOR_TOO_MANY_ATTEMPTS_MESSAGE,
  });
};

export const enforceTwoFactorAttemptLimit = async (
  params: Omit<ConsumeTwoFactorAttemptParams, 'challengeId'> & {
    challengeId: string | null | undefined;
  },
): Promise<void> => {
  if (!params.challengeId) return;

  const result = await consumeTwoFactorAttempt({
    ...params,
    challengeId: params.challengeId,
  });
  if (result.allowed) return;

  rejectTwoFactorTooManyAttempts();
};

/**
 * Process-local atomic increment. Used when Redis is not configured (tests,
 * single-node without Redis). Concurrent callers for the same key are
 * serialized on a per-key promise tail — not a read-then-write.
 */
export const createMemoryAtomicIncrement = () => {
  const counts = new Map<string, { count: number; expiresAt: number }>();
  const tails = new Map<string, Promise<unknown>>();

  const increment = async (key: string, ttlSeconds = TWO_FACTOR_ATTEMPT_WINDOW_SECONDS) => {
    const previous = tails.get(key) ?? Promise.resolve();
    let nextCount = 0;
    const next = previous.then(() => {
      const now = Date.now();
      const current = counts.get(key);
      nextCount = !current || current.expiresAt <= now ? 1 : current.count + 1;
      counts.set(key, { count: nextCount, expiresAt: now + ttlSeconds * 1000 });
    });
    tails.set(
      key,
      next.catch(() => undefined),
    );
    await next;
    return nextCount;
  };

  return { increment };
};

export interface TwoFactorAttemptLimitOptions {
  delete?: (key: string) => Promise<void>;
  increment?: (key: string, ttlSeconds?: number) => Promise<number>;
  maxAttempts?: number;
}

/**
 * Counts every verify-totp / verify-backup-code attempt *before* the TOTP is
 * evaluated, with an atomic increment. better-auth's built-in limiter is
 * per-IP and does a separate get-then-set, so parallel batches all read the
 * same count. This plugin is the per-challenge counter that actually serializes.
 */
export const twoFactorAttemptLimit = (
  options: TwoFactorAttemptLimitOptions = {},
): BetterAuthPlugin => {
  const increment = options.increment ?? createMemoryAtomicIncrement().increment;
  const maxAttempts = options.maxAttempts ?? TWO_FACTOR_MAX_ATTEMPTS;

  return {
    hooks: {
      before: [
        {
          handler: createAuthMiddleware(async (ctx) => {
            const cookie = ctx.context.createAuthCookie('two_factor');
            const signed = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
            const challengeId = typeof signed === 'string' && signed.length > 0 ? signed : null;

            await enforceTwoFactorAttemptLimit({
              challengeId,
              increment,
              invalidate: async () => {
                if (!challengeId) return;
                await ctx.context.internalAdapter.deleteVerificationByIdentifier(challengeId);
                await options.delete?.(attemptKey(challengeId));
              },
              maxAttempts,
            });
          }),
          matcher: (ctx) =>
            typeof ctx.path === 'string' && TWO_FACTOR_ATTEMPT_LIMIT_PATHS.has(ctx.path),
        },
      ],
    },
    id: 'two-factor-attempt-limit',
  };
};
