import { defineConfig } from '@/libs/better-auth/define-config';
import { getInitializedIdentityProviderRuntimeArtifact } from '@/server/enterprise/services/identityProvider/startupArtifact';

const identitySnapshot = getInitializedIdentityProviderRuntimeArtifact();

export const auth = defineConfig(
  { plugins: [] },
  {
    databaseProviders: identitySnapshot.databaseProviders,
    providerIds: identitySnapshot.providerIds,
  },
);
