import type { z } from 'zod';

import { platformConnectorsService } from '@/enterprise/client/services/platformConnectors';
import type {
  connectorBindingSchema,
  managedConnectorSchema,
  userConnectorDisconnectInputSchema,
  userConnectorDisconnectOutputSchema,
  userConnectorGetAuthorizationStatusInputSchema,
  userConnectorGetAuthorizationStatusOutputSchema,
  userConnectorListManagedInputSchema,
  userConnectorListManagedOutputSchema,
  userConnectorStartAuthorizationInputSchema,
  userConnectorStartAuthorizationOutputSchema,
} from '@/server/enterprise/contracts/platformConnectors';
import { platformConnectorErrorCodeSchema } from '@/server/enterprise/contracts/platformConnectors';

export type ManagedConnector = z.infer<typeof managedConnectorSchema>;
export type ManagedConnectorBinding = z.infer<typeof connectorBindingSchema>;
export type PlatformConnectorContractErrorCode = z.infer<typeof platformConnectorErrorCodeSchema>;
export type UserConnectorDisconnectInput = z.infer<typeof userConnectorDisconnectInputSchema>;
export type UserConnectorDisconnectOutput = z.infer<typeof userConnectorDisconnectOutputSchema>;
export type UserConnectorAuthorizationStatusInput = z.infer<
  typeof userConnectorGetAuthorizationStatusInputSchema
>;
export type UserConnectorAuthorizationStatusOutput = z.infer<
  typeof userConnectorGetAuthorizationStatusOutputSchema
>;
export type UserConnectorListInput = z.infer<typeof userConnectorListManagedInputSchema>;
export type UserConnectorListOutput = z.infer<typeof userConnectorListManagedOutputSchema>;
export type UserConnectorStartAuthorizationInput = z.infer<
  typeof userConnectorStartAuthorizationInputSchema
>;
export type UserConnectorStartAuthorizationOutput = z.infer<
  typeof userConnectorStartAuthorizationOutputSchema
>;

export const parsePlatformConnectorErrorCode = (
  value: unknown,
): PlatformConnectorContractErrorCode | null => {
  const parsed = platformConnectorErrorCodeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

/** The only ordinary-client seam allowed to call the enterprise Connector service. */
export const managedConnectorClient = {
  disconnect: (input: UserConnectorDisconnectInput): Promise<UserConnectorDisconnectOutput> =>
    platformConnectorsService.disconnect(input),
  getAuthorizationStatus: (
    input: UserConnectorAuthorizationStatusInput,
  ): Promise<UserConnectorAuthorizationStatusOutput> =>
    platformConnectorsService.getAuthorizationStatus(input),
  listManaged: (input: UserConnectorListInput): Promise<UserConnectorListOutput> =>
    platformConnectorsService.listManaged(input),
  startAuthorization: (
    input: UserConnectorStartAuthorizationInput,
  ): Promise<UserConnectorStartAuthorizationOutput> =>
    platformConnectorsService.startAuthorization(input),
};
