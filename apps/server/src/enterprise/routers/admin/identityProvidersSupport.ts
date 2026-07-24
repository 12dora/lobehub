import type { LobeChatDatabase } from '@/database/type';
import { appEnv } from '@/envs/app';

import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import { SafeOutboundHttpClient } from '../../security/outboundHttp';
import { PlatformSecretService } from '../../security/secret';
import { AdminIdentityProviderService } from '../../services/identityProvider/adminService';
import { createIdentityProviderSecurityFoundation } from '../../services/identityProvider/factory';
import { resolveIdentityProviderOutboundMode } from '../../services/identityProvider/outboundMode';
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
  const foundation = createIdentityProviderSecurityFoundation(db, env);
  if (!foundation) throw new Error('PLATFORM_FEATURE_DISABLED');
  const flags = parseEnterpriseFeatureFlags(env);
  const secretService = PlatformSecretService.fromEnvOrThrowIfEnterprise(env, flags);
  if (!secretService) throw new Error('PLATFORM_SECRET_REQUIRED');
  // Shared outbound client so test token/userinfo exchange uses the same SSRF boundary as
  // discovery. Honors SSRF_ALLOW_PRIVATE_IP_ADDRESS so internal-network issuers work end-to-end.
  const outbound = new SafeOutboundHttpClient({ mode: resolveIdentityProviderOutboundMode(env) });
  const publicAppUrl = env === process.env ? appEnv.APP_URL : env.APP_URL;
  if (!publicAppUrl) throw new Error('PLATFORM_APP_URL_INVALID');
  return {
    admin: new AdminIdentityProviderService(db, secretService, foundation.discovery, publicAppUrl),
    test: new IdentityProviderTestFlowService(db, secretService, foundation.discovery, outbound),
  };
};
