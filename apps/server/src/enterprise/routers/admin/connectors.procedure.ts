import type { LobeChatDatabase } from '@/database/type';
import { authedProcedure } from '@/libs/trpc/lambda';
import type { AuthMethod } from '@/libs/trpc/lambda/context';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import { withActiveUser } from '../../guards/activeUser';
import { withAdminMutationRateLimit } from '../../guards/adminMutationRateLimit';
import type { AdminConnectorRuntime } from './connectorsSupport';
import { createAdminConnectorReadRuntime, createAdminConnectorRuntime } from './connectorsSupport';

export type AdminConnectorCtx = {
  authenticatedAt?: Date | null;
  authMethod?: AuthMethod;
  getAdminConnectorReadService: () => ReturnType<typeof createAdminConnectorReadRuntime>['service'];
  getAdminConnectorRuntime: () => AdminConnectorRuntime;
  serverDB: LobeChatDatabase;
  userId?: string | null;
};

export const adminConnectorProcedure = authedProcedure
  .use(serverDatabase)
  .use(withActiveUser())
  .use(withAdminMutationRateLimit())
  .use(async ({ ctx, next }) =>
    next({
      ctx: {
        // Secret-free path for pure reads (list/get/getBatch/getPublishedBatch); no master key.
        getAdminConnectorReadService: () => createAdminConnectorReadRuntime(ctx.serverDB).service,
        getAdminConnectorRuntime: () => createAdminConnectorRuntime(ctx.serverDB),
      },
    }),
  );

export const replacementSecrets = (input: {
  oauthClientSecret?: { operation: string; value?: unknown };
  reason?: string;
  sharedSecret?: { operation: string; value?: unknown };
}): unknown[] => [
  ...(input.oauthClientSecret?.operation === 'replace' ? [input.oauthClientSecret.value] : []),
  ...(input.sharedSecret?.operation === 'replace' ? [input.sharedSecret.value] : []),
];
