import type { LobeChatDatabase } from '@/database/type';

import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import { SafeOutboundHttpClient } from '../../security/outboundHttp';
import { PlatformSecretService } from '../../security/secret';
import type { ConnectorCatalogSecretStore } from './catalogTypes';
import { ConnectorOutboundClient } from './connectorOutboundClient';
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

const resolveCallbackRedirectUri = (env: ConnectorOAuthRuntimeEnv): string => {
  const appUrl = env.APP_URL?.trim();
  if (!appUrl) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
  }
  try {
    return new URL('/oauth/connector/callback', appUrl).toString();
  } catch {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
  }
};

/**
 * Cold-start-safe production factory. Both the standalone server router and
 * the Next callback construct their own dependencies from shared DB + M13
 * primitives; no cross-process module registration is required.
 */
export const getConnectorOAuthRuntime = (
  db: LobeChatDatabase,
  env: ConnectorOAuthRuntimeEnv = process.env,
): ConnectorOAuthRuntimeDependencies => {
  const flags = parseEnterpriseFeatureFlags(env);
  if (!flags.ENABLE_PLATFORM_MANAGED_CONNECTORS) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
  }
  const secretService = PlatformSecretService.fromEnvOrThrowIfEnterprise(env, flags);
  if (!secretService) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
  }
  return {
    callbackRedirectUri: resolveCallbackRedirectUri(env),
    outbound: new ConnectorOAuthOutboundAdapter(
      new ConnectorOutboundClient(new SafeOutboundHttpClient()),
    ),
    secrets: new PlatformConnectorSecretStore(db, secretService),
  };
};
