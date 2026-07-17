import { TRPCError } from '@trpc/server';

import { PlatformConnectorContractError } from '../services/connectorCatalog/errors';
import { assertLegacyConnectorRuntimeAllowed } from '../services/connectorCatalog/runtimeIntegration';

type ConnectorRuntimeGuardParams = Parameters<typeof assertLegacyConnectorRuntimeAllowed>[0];

export const mapConnectorRuntimeTransportError = (error: unknown): TRPCError | undefined => {
  if (error instanceof TRPCError) return error;
  if (!(error instanceof PlatformConnectorContractError)) return;
  return new TRPCError({
    cause: error,
    code: error.code === 'PLATFORM_CONNECTOR_NOT_PUBLISHED' ? 'PRECONDITION_FAILED' : 'FORBIDDEN',
    message: error.code,
  });
};

/** Preserve the stable PLATFORM_CONNECTOR_* contract at direct tRPC transport boundaries. */
export const assertLegacyConnectorTransportAllowed = async (
  params: ConnectorRuntimeGuardParams = {},
): Promise<void> => {
  try {
    await assertLegacyConnectorRuntimeAllowed(params);
  } catch (error) {
    const mapped = mapConnectorRuntimeTransportError(error);
    if (mapped) throw mapped;
    throw error;
  }
};
