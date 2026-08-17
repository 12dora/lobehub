import { TRPCError } from '@trpc/server';
import debug from 'debug';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { preAccessAuthedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import {
  adminBrowserProfileGetOutputSchema,
  adminBrowserProfileRegenerateInputSchema,
  adminBrowserProfileRegenerateOutputSchema,
} from '../../contracts/adminBrowserProfile';
import { withActiveUser } from '../../guards/activeUser';
import { withAdminMutationRateLimit } from '../../guards/adminMutationRateLimit';
import { withPlatformPermission } from '../../guards/platformPermission';
import { PlatformBrowserProfileService } from '../../services/browserProfile';

const log = debug('lobe-server:browser-profile');

const browserProfileBase = preAccessAuthedProcedure
  .use(serverDatabase)
  .use(withActiveUser())
  .use(withAdminMutationRateLimit());

const execute = async <T>(operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    // Error class only: the profile and its seed must never reach a log line.
    log('operation unavailable: %s', error instanceof Error ? error.name : 'UnknownError');
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Platform browser profile is temporarily unavailable',
    });
  }
};

export const adminBrowserProfileRouter = router({
  get: browserProfileBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SYSTEM_READ))
    .output(adminBrowserProfileGetOutputSchema)
    .query(({ ctx }) =>
      execute(() => new PlatformBrowserProfileService(ctx.serverDB).getSummary()),
    ),

  regenerate: browserProfileBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SYSTEM_OPERATE))
    .input(adminBrowserProfileRegenerateInputSchema)
    .output(adminBrowserProfileRegenerateOutputSchema)
    .mutation(({ ctx, input }) =>
      execute(() =>
        new PlatformBrowserProfileService(ctx.serverDB).regenerate({
          actorUserId: ctx.userId!,
          reason: input.reason,
        }),
      ),
    ),
});
