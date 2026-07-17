import type { z } from 'zod';

import { lambdaClient } from '@/libs/trpc/client';
import type {
  userConnectorDisconnectInputSchema,
  userConnectorDisconnectOutputSchema,
  userConnectorGetAuthorizationStatusInputSchema,
  userConnectorGetAuthorizationStatusOutputSchema,
  userConnectorListManagedInputSchema,
  userConnectorListManagedOutputSchema,
  userConnectorStartAuthorizationInputSchema,
  userConnectorStartAuthorizationOutputSchema,
} from '@/server/enterprise/contracts/platformConnectors';

type UserConnectorDisconnectInput = z.infer<typeof userConnectorDisconnectInputSchema>;
type UserConnectorDisconnectOutput = z.infer<typeof userConnectorDisconnectOutputSchema>;
type UserConnectorAuthorizationStatusInput = z.infer<
  typeof userConnectorGetAuthorizationStatusInputSchema
>;
type UserConnectorAuthorizationStatusOutput = z.infer<
  typeof userConnectorGetAuthorizationStatusOutputSchema
>;
type UserConnectorListInput = z.infer<typeof userConnectorListManagedInputSchema>;
type UserConnectorListOutput = z.infer<typeof userConnectorListManagedOutputSchema>;
type UserConnectorStartAuthorizationInput = z.infer<
  typeof userConnectorStartAuthorizationInputSchema
>;
type UserConnectorStartAuthorizationOutput = z.infer<
  typeof userConnectorStartAuthorizationOutputSchema
>;

class PlatformConnectorsService {
  disconnect = async (
    input: UserConnectorDisconnectInput,
  ): Promise<UserConnectorDisconnectOutput> =>
    lambdaClient.user.connectors.disconnect.mutate(input);

  getAuthorizationStatus = async (
    input: UserConnectorAuthorizationStatusInput,
  ): Promise<UserConnectorAuthorizationStatusOutput> =>
    lambdaClient.user.connectors.getAuthorizationStatus.query(input);

  listManaged = async (input: UserConnectorListInput): Promise<UserConnectorListOutput> =>
    lambdaClient.user.connectors.listManaged.query(input);

  startAuthorization = async (
    input: UserConnectorStartAuthorizationInput,
  ): Promise<UserConnectorStartAuthorizationOutput> =>
    lambdaClient.user.connectors.startAuthorization.mutate(input);
}

export const platformConnectorsService = new PlatformConnectorsService();
