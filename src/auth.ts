import { defineConfig } from '@/libs/better-auth/define-config';
import { loadIdentityProviderStartupSnapshot } from '@/server/enterprise/services/identityProvider/startupSnapshot';

const identitySnapshot = await loadIdentityProviderStartupSnapshot();

export const auth = defineConfig(
  { plugins: [] },
  {
    databaseProviders: identitySnapshot.databaseProviders,
    providerIds: identitySnapshot.providerIds,
  },
);
