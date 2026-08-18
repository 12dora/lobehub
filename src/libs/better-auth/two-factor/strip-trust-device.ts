import { createAuthMiddleware } from 'better-auth/api';
import type { BetterAuthPlugin } from 'better-auth/types';

import { TWO_FACTOR_VERIFICATION_PATHS } from './session-gate';

/**
 * Trusted-device cookies were never shipped: the UI checkbox was removed on
 * this same unpushed branch. There are no production `trust-device-*`
 * verification rows to purge. The stock two-factor handler still honours
 * `trustDevice: true` on verify and then skips the challenge on later
 * sign-ins, so we delete the field before that handler runs.
 */
export const stripTrustDeviceFromBody = <T extends Record<string, unknown>>(
  body: T,
): Omit<T, 'trustDevice'> => {
  if (!('trustDevice' in body)) return body;
  const { trustDevice: _trustDevice, ...rest } = body;
  return rest;
};

export const stripTrustDeviceHook = {
  handler: createAuthMiddleware(async (ctx) => {
    const body = ctx.body;
    if (!body || typeof body !== 'object' || !('trustDevice' in body)) return;

    return {
      context: {
        body: stripTrustDeviceFromBody(body as Record<string, unknown>),
      },
    };
  }),
  matcher: (ctx: { path?: string }) =>
    typeof ctx.path === 'string' && TWO_FACTOR_VERIFICATION_PATHS.has(ctx.path),
};

export const stripTrustDevice = (): BetterAuthPlugin => ({
  hooks: {
    before: [stripTrustDeviceHook],
  },
  id: 'strip-trust-device',
});
