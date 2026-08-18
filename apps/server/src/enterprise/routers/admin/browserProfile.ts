import { BrowserProfileOptionError } from '@lobechat/model-runtime/browserProfile';
import { TRPCError } from '@trpc/server';
import debug from 'debug';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { PlatformRevisionConflictError } from '@/database/models/platform/errors';
import { preAccessAuthedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import {
  adminBrowserProfileGetOutputSchema,
  adminBrowserProfileOptionsSchema,
  adminBrowserProfileRegenerateInputSchema,
  adminBrowserProfileRegenerateOutputSchema,
  adminBrowserProfileUpdateInputSchema,
  adminBrowserProfileUpdateOutputSchema,
} from '../../contracts/adminBrowserProfile';
import { withActiveUser } from '../../guards/activeUser';
import { withAdminMutationRateLimit } from '../../guards/adminMutationRateLimit';
import { throwEnterpriseError } from '../../guards/enterpriseErrors';
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
    if (error instanceof TRPCError) throw error;
    if (error instanceof PlatformRevisionConflictError) {
      throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT,
        httpCode: 'CONFLICT',
        message: 'Platform browser profile was changed by another operator',
      });
    }
    if (error instanceof BrowserProfileOptionError) {
      throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
        httpCode: 'BAD_REQUEST',
        message: error.message,
      });
    }
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

  options: browserProfileBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SYSTEM_READ))
    .output(adminBrowserProfileOptionsSchema)
    .query(({ ctx }) =>
      execute(async () => new PlatformBrowserProfileService(ctx.serverDB).getOptions()),
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

  update: browserProfileBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SYSTEM_OPERATE))
    .input(adminBrowserProfileUpdateInputSchema)
    .output(adminBrowserProfileUpdateOutputSchema)
    .mutation(({ ctx, input }) =>
      execute(() =>
        new PlatformBrowserProfileService(ctx.serverDB).update({
          actorUserId: ctx.userId!,
          chromeId: input.chromeId,
          computeId: input.computeId,
          expectedRevision: input.expectedRevision,
          localeId: input.localeId,
          reason: input.reason,
          screenId: input.screenId,
          systemId: input.systemId,
          webglId: input.webglId,
        }),
      ),
    ),
});
