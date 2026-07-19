import type { LobeChatDatabase } from '@/database/type';
import { appEnv } from '@/envs/app';

import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import { SafeOutboundHttpClient } from '../../security/outboundHttp';
import { PlatformSecretService } from '../../security/secret';
import { AdminIdentityProviderService } from '../../services/identityProvider/adminService';
import { IdentityProviderDiscoveryValidator } from '../../services/identityProvider/discoveryValidator';
import { IdentityProviderTestFlowService } from '../../services/identityProvider/testFlowService';

export interface AdminIdentityProviderRuntime {
  admin: AdminIdentityProviderService;
  test: IdentityProviderTestFlowService;
}

export const isIdentityProviderFeatureEnabled = (
  env: Record<string, string | undefined> = process.env,
): boolean => parseEnterpriseFeatureFlags(env).ENABLE_DATABASE_OIDC;

export const createAdminIdentityProviderRuntime = (
  db: LobeChatDatabase,
  env: Record<string, string | undefined> = process.env,
): AdminIdentityProviderRuntime => {
  if (!isIdentityProviderFeatureEnabled(env)) throw new Error('PLATFORM_FEATURE_DISABLED');
  const flags = parseEnterpriseFeatureFlags(env);
  const secretService = PlatformSecretService.fromEnvOrThrowIfEnterprise(env, flags);
  if (!secretService) throw new Error('PLATFORM_SECRET_REQUIRED');
  const outbound = new SafeOutboundHttpClient({ mode: 'public-only' });
  const discovery = new IdentityProviderDiscoveryValidator(outbound);
  const publicAppUrl = env === process.env ? appEnv.APP_URL : env.APP_URL;
  if (!publicAppUrl) throw new Error('PLATFORM_APP_URL_INVALID');
  return {
    admin: new AdminIdentityProviderService(db, secretService, discovery, publicAppUrl),
    test: new IdentityProviderTestFlowService(db, secretService, discovery, outbound),
  };
};
