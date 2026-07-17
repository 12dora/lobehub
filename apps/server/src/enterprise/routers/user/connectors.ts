import { TRPCError } from '@trpc/server';

import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import {
  userConnectorDisconnectInputSchema,
  userConnectorDisconnectOutputSchema,
  userConnectorGetAuthorizationStatusInputSchema,
  userConnectorGetAuthorizationStatusOutputSchema,
  userConnectorListManagedInputSchema,
  userConnectorListManagedOutputSchema,
  userConnectorStartAuthorizationInputSchema,
  userConnectorStartAuthorizationOutputSchema,
} from '../../contracts/platformConnectors';
import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import { PlatformConnectorContractError } from '../../services/connectorCatalog/errors';
import { getConnectorOAuthRuntime } from '../../services/connectorCatalog/oauthRuntime';
import { UserConnectorOAuthService } from '../../services/connectorCatalog/userOAuthService';

const userConnectorProcedure = authedProcedure.use(serverDatabase).use(async ({ ctx, next }) =>
  next({
    ctx: {
      getUserConnectorOAuthService: () =>
        new UserConnectorOAuthService(
          ctx.serverDB,
          ctx.userId!,
          getConnectorOAuthRuntime(ctx.serverDB),
        ),
    },
  }),
);

const featureEnabled = (): boolean =>
  parseEnterpriseFeatureFlags(process.env).ENABLE_PLATFORM_MANAGED_CONNECTORS;

const execute = async <T>(operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    if (error instanceof PlatformConnectorContractError) {
      throw new TRPCError({
        code:
          error.code === 'PLATFORM_CONNECTOR_NOT_FOUND' ||
          error.code === 'PLATFORM_CONNECTOR_BINDING_NOT_FOUND'
            ? 'NOT_FOUND'
            : error.code === 'PLATFORM_CONNECTOR_RESOURCE_MISMATCH'
              ? 'CONFLICT'
              : 'BAD_REQUEST',
        message: error.code,
      });
    }
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'PLATFORM_CONNECTOR_OPERATION_FAILED',
    });
  }
};

export const userConnectorsRouter = router({
  disconnect: userConnectorProcedure
    .input(userConnectorDisconnectInputSchema)
    .output(userConnectorDisconnectOutputSchema)
    .mutation(async ({ ctx, input }) => {
      if (!featureEnabled()) return { disconnected: true as const };
      return execute(() => ctx.getUserConnectorOAuthService().disconnect(input));
    }),

  getAuthorizationStatus: userConnectorProcedure
    .input(userConnectorGetAuthorizationStatusInputSchema)
    .output(userConnectorGetAuthorizationStatusOutputSchema)
    .query(async ({ ctx, input }) => {
      if (!featureEnabled()) {
        return { attemptId: input.attemptId, binding: null, status: 'invalid' as const };
      }
      return execute(() => ctx.getUserConnectorOAuthService().getAuthorizationStatus(input));
    }),

  listManaged: userConnectorProcedure
    .input(userConnectorListManagedInputSchema)
    .output(userConnectorListManagedOutputSchema)
    .query(async ({ ctx, input }) => {
      if (!featureEnabled()) return { items: [], nextCursor: null };
      return execute(() => ctx.getUserConnectorOAuthService().listManaged(input));
    }),

  startAuthorization: userConnectorProcedure
    .input(userConnectorStartAuthorizationInputSchema)
    .output(userConnectorStartAuthorizationOutputSchema)
    .mutation(async ({ ctx, input }) => {
      if (!featureEnabled()) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'PLATFORM_FEATURE_DISABLED' });
      }
      return execute(() => ctx.getUserConnectorOAuthService().startAuthorization(input));
    }),
});

export type UserConnectorsRouter = typeof userConnectorsRouter;
