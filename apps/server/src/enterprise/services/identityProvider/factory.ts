import type { LobeChatDatabase } from '@/database/type';

import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import type { SafeOutboundHttpClientOptions } from '../../security/outboundHttp';
import { SafeOutboundHttpClient } from '../../security/outboundHttp';
import { PlatformSecretService } from '../../security/secret';
import { IdentityProviderDiscoveryValidator } from './discoveryValidator';
import { resolveIdentityProviderOutboundMode } from './outboundMode';
import { IdentityProviderSecretStore } from './secretStore';

/** Local return type for the factory — not part of the public package surface. */
interface IdentityProviderSecurityFoundation {
  discovery: IdentityProviderDiscoveryValidator;
  secrets: IdentityProviderSecretStore;
}

/** Flag-off is a strict no-op; flag-on requires the existing M13 secret foundation. */
export const createIdentityProviderSecurityFoundation = (
  db: LobeChatDatabase,
  env: Record<string, string | undefined> = process.env,
  outboundOptions: Omit<SafeOutboundHttpClientOptions, 'mode'> = {},
): IdentityProviderSecurityFoundation | null => {
  const flags = parseEnterpriseFeatureFlags(env);
  if (!flags.ENABLE_DATABASE_OIDC) return null;
  const secretService = PlatformSecretService.fromEnvOrThrowIfEnterprise(env, flags);
  if (!secretService) throw new Error('PLATFORM_IDENTITY_PROVIDER_SECRET_REQUIRED');
  return {
    discovery: new IdentityProviderDiscoveryValidator(
      new SafeOutboundHttpClient({
        ...outboundOptions,
        mode: resolveIdentityProviderOutboundMode(env),
      }),
    ),
    secrets: new IdentityProviderSecretStore(db, secretService),
  };
};
