import { TRPCError } from '@trpc/server';

import { AUTH_BACKEND_UNAVAILABLE } from '../lambda/context';
import { trpc } from '../lambda/init';

export const userAuth = trpc.middleware(async (opts) => {
  const { ctx } = opts;

  // Redis / Better Auth backend failure is not "logged out".
  if (ctx.authBackendUnavailable) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: AUTH_BACKEND_UNAVAILABLE,
    });
  }

  // `ctx.user` is nullable
  if (!ctx.userId) {
    throw new TRPCError({ code: 'UNAUTHORIZED' });
  }

  return opts.next({
    // ✅ user value is known to be non-null now
    ctx: { userId: ctx.userId },
  });
});
