/**
 * Shared Better Auth cookie-cache settings.
 *
 * The edge session reader (`src/auth.proxy.ts`) and Better Auth server config
 * (`define-config.ts`) must stay in lockstep: if the library cache outlives
 * what middleware considers valid (or vice versa), users get bounced to
 * /signin while the DB session is still live.
 */

/** Cookie-cache duration in seconds (`session.cookieCache.maxAge`). */
export const SESSION_COOKIE_CACHE_MAX_AGE_SECONDS = 5 * 60;

/** Same duration in milliseconds for the edge/middleware cache reader. */
export const SESSION_COOKIE_CACHE_MAX_AGE_MS = SESSION_COOKIE_CACHE_MAX_AGE_SECONDS * 1000;

/** Must match Better Auth `session.cookieCache.strategy` and the edge reader. */
export const SESSION_COOKIE_CACHE_STRATEGY = 'compact' as const;
