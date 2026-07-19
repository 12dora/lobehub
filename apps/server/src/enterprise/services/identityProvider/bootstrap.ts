import { PHASE_PRODUCTION_BUILD } from 'next/constants';

import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import {
  markIdentityProviderInstanceRegistrationFailed,
  registerIdentityProviderInstance,
} from './instanceRegistry';
import { commitIdentityProviderStartupSnapshot } from './startupArtifact';
import {
  loadIdentityProviderStartupSnapshot,
  parseEnvironmentIdentityProviderIds,
} from './startupSnapshot';

const bootstrapProcess = process as NodeJS.Process & {
  __lobehubIdentityProviderBootstrapPromise?: Promise<void>;
};

const bootstrapBuildSnapshot = (): void => {
  commitIdentityProviderStartupSnapshot({
    databaseProviders: [],
    generation: null,
    health: 'healthy',
    identityRevision: null,
    lastError: null,
    loadedAt: new Date(0),
    providerIds: parseEnvironmentIdentityProviderIds(process.env),
    source: 'environment',
  });
};

/** The node instrumentation hook is the sole production owner of startup loading. */
export const bootstrapIdentityProviderRuntime = (): Promise<void> => {
  if (process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD) {
    bootstrapBuildSnapshot();
    return Promise.resolve();
  }
  bootstrapProcess.__lobehubIdentityProviderBootstrapPromise ??=
    loadIdentityProviderStartupSnapshot().then(async (snapshot) => {
      if (!parseEnterpriseFeatureFlags(process.env).ENABLE_DATABASE_OIDC) return;
      try {
        const { serverDB } = await import('@lobechat/database');
        await registerIdentityProviderInstance({ db: serverDB, snapshot });
      } catch (error) {
        markIdentityProviderInstanceRegistrationFailed();
        console.error('[identityProviderInstance] startup report unavailable', {
          errorClass: error instanceof Error ? error.name : 'UnknownError',
        });
      }
    });
  return bootstrapProcess.__lobehubIdentityProviderBootstrapPromise;
};

export const resetIdentityProviderBootstrapForTest = (): void => {
  delete bootstrapProcess.__lobehubIdentityProviderBootstrapPromise;
};
