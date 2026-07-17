import type {
  UserConnectorAuthorizationStatusInput,
  UserConnectorAuthorizationStatusOutput,
  UserConnectorDisconnectInput,
  UserConnectorDisconnectOutput,
  UserConnectorListInput,
  UserConnectorListOutput,
  UserConnectorStartAuthorizationInput,
  UserConnectorStartAuthorizationOutput,
} from '@/features/PlatformConnectorAuthorization/types';
import { lambdaClient } from '@/libs/trpc/client';

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
