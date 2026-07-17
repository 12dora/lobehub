import type { LobeChatDatabase } from '@/database/type';

import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import { SafeOutboundHttpClient } from '../../security/outboundHttp';
import { PlatformSecretService } from '../../security/secret';
import type { ConnectorCatalogSecretStore } from './catalogTypes';
import {
  canonicalConnectorAppUrlProvider,
  type ConnectorAppUrlProvider,
  resolveConnectorCallbackRedirectUri,
} from './connectorCallbackRedirect';
import { ConnectorOutboundClient } from './connectorOutboundClient';
import { connectorOutboundPolicyProvider } from './connectorOutboundPolicy';
import { PlatformConnectorContractError } from './errors';
import { ConnectorOAuthOutboundAdapter } from './oauthOutboundAdapter';
import { PlatformConnectorSecretStore } from './platformConnectorSecretStore';

export interface ConnectorOAuthRuntimeDependencies {
  callbackRedirectUri: string;
  clock?: () => Date;
  outbound: ConnectorOAuthOutboundAdapter;
  randomBytes?: (size: number) => Buffer;
  secrets: ConnectorCatalogSecretStore;
}

export const MANAGED_CONNECTOR_OAUTH_STATE_PREFIX = 'aihub-m09-v1.';

export type ConnectorOAuthRuntimeEnv = Record<string, string | undefined>;

/**
 * Cold-start-safe production factory. Both the standalone server router and
 * the Next callback construct their own dependencies from shared DB + M13
 * primitives; no cross-process module registration is required.
 */
export const getConnectorOAuthRuntime = (
  db: LobeChatDatabase,
  env: ConnectorOAuthRuntimeEnv = process.env,
  options: { appUrlProvider?: ConnectorAppUrlProvider } = {},
): ConnectorOAuthRuntimeDependencies => {
  const flags = parseEnterpriseFeatureFlags(env);
  if (!flags.ENABLE_PLATFORM_MANAGED_CONNECTORS) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
  }
  const secretService = PlatformSecretService.fromEnvOrThrowIfEnterprise(env, flags);
  if (!secretService) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
  }
  const appUrlProvider =
    options.appUrlProvider ??
    (env === process.env ? canonicalConnectorAppUrlProvider : () => env.APP_URL);
  return {
    callbackRedirectUri: resolveConnectorCallbackRedirectUri(appUrlProvider),
    outbound: new ConnectorOAuthOutboundAdapter(
      new ConnectorOutboundClient(
        new SafeOutboundHttpClient({ policyProvider: connectorOutboundPolicyProvider }),
      ),
    ),
    secrets: new PlatformConnectorSecretStore(db, secretService),
  };
};
