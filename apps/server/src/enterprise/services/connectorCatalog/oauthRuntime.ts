import type { ConnectorCatalogSecretStore } from './catalogTypes';
import { PlatformConnectorContractError } from './errors';
import type { ConnectorOAuthOutboundAdapter } from './oauthOutboundAdapter';

export interface ConnectorOAuthRuntimeDependencies {
  callbackRedirectUri: string;
  clock?: () => Date;
  outbound: ConnectorOAuthOutboundAdapter;
  randomBytes?: (size: number) => Buffer;
  secrets: ConnectorCatalogSecretStore;
}

export const MANAGED_CONNECTOR_OAUTH_STATE_PREFIX = 'aihub-m09-v1.';

type ConnectorOAuthRuntimeProvider = () => ConnectorOAuthRuntimeDependencies;

let runtimeProvider: ConnectorOAuthRuntimeProvider | undefined;

/** M13 registers the production Secret Store + outbound runtime at bootstrap. */
export const registerConnectorOAuthRuntime = (provider: ConnectorOAuthRuntimeProvider): void => {
  runtimeProvider = provider;
};

export const resetConnectorOAuthRuntimeForTests = (): void => {
  runtimeProvider = undefined;
};

export const getConnectorOAuthRuntime = (): ConnectorOAuthRuntimeDependencies => {
  if (!runtimeProvider) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
  }
  return runtimeProvider();
};
