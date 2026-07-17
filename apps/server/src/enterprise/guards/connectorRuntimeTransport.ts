import { TRPCError } from '@trpc/server';

import { PlatformConnectorContractError } from '../services/connectorCatalog/errors';
import { assertLegacyConnectorRuntimeAllowed } from '../services/connectorCatalog/runtimeIntegration';

type ConnectorRuntimeGuardParams = Parameters<typeof assertLegacyConnectorRuntimeAllowed>[0];

/** Preserve the stable PLATFORM_CONNECTOR_* contract at direct tRPC transport boundaries. */
export const assertLegacyConnectorTransportAllowed = async (
  params: ConnectorRuntimeGuardParams = {},
): Promise<void> => {
  try {
    await assertLegacyConnectorRuntimeAllowed(params);
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    if (error instanceof PlatformConnectorContractError) {
      throw new TRPCError({
        cause: error,
        code:
          error.code === 'PLATFORM_CONNECTOR_NOT_PUBLISHED' ? 'PRECONDITION_FAILED' : 'FORBIDDEN',
        message: error.code,
      });
    }
    throw error;
  }
};
