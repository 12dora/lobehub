import { defineConfig } from '@/libs/better-auth/define-config';
import { bootstrapIdentityProviderRuntime } from '@/server/enterprise/services/identityProvider/bootstrap';
import { getInitializedIdentityProviderRuntimeArtifact } from '@/server/enterprise/services/identityProvider/startupArtifact';

// Next may evaluate auth in a worker process that cannot observe instrumentation memory.
// Bootstrap this worker explicitly before Better Auth consumes the immutable snapshot.
await bootstrapIdentityProviderRuntime();
const identitySnapshot = getInitializedIdentityProviderRuntimeArtifact();

export const auth = defineConfig(
  { plugins: [] },
  {
    databaseProviders: identitySnapshot.databaseProviders,
    providerIds: identitySnapshot.providerIds,
  },
);
