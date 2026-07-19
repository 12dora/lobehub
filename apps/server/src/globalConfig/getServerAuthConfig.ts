import { ENABLE_BUSINESS_FEATURES } from '@lobechat/business-const';

import { appEnv } from '@/envs/app';
import { authEnv } from '@/envs/auth';
import { getInitializedIdentityProviderPublicArtifact } from '@/server/enterprise/services/identityProvider/startupArtifact';
import { type GlobalServerConfig } from '@/types/serverConfig';

import { isAnyEnterpriseFeatureEnabled } from '../enterprise/featureFlags';

export const getServerAuthConfig = (): GlobalServerConfig => {
  const identitySnapshot = getInitializedIdentityProviderPublicArtifact();
  return {
    aiProvider: {},
    disableEmailPassword: authEnv.AUTH_DISABLE_EMAIL_PASSWORD,
    enableBusinessFeatures: ENABLE_BUSINESS_FEATURES,
    enableEmailVerification: authEnv.AUTH_EMAIL_VERIFICATION,
    enableMagicLink: authEnv.AUTH_ENABLE_MAGIC_LINK,
    enableMarketTrustedClient: !!(
      appEnv.MARKET_TRUSTED_CLIENT_SECRET && appEnv.MARKET_TRUSTED_CLIENT_ID
    ),
    enterprise: { enabled: isAnyEnterpriseFeatureEnabled(), platformAdmin: false },
    oAuthSSOProviders: identitySnapshot.providerIds,
    telemetry: {},
  };
};
