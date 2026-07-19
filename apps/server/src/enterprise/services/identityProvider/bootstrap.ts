import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import { registerIdentityProviderInstance } from './instanceRegistry';
import { loadIdentityProviderStartupSnapshot } from './startupSnapshot';

let bootstrapPromise: Promise<void> | null = null;

/** The node instrumentation hook is the sole production owner of startup loading. */
export const bootstrapIdentityProviderRuntime = (): Promise<void> => {
  bootstrapPromise ??= loadIdentityProviderStartupSnapshot().then(async (snapshot) => {
    if (!parseEnterpriseFeatureFlags(process.env).ENABLE_DATABASE_OIDC) return;
    try {
      const { serverDB } = await import('@lobechat/database');
      await registerIdentityProviderInstance({ db: serverDB, snapshot });
    } catch (error) {
      console.error('[identityProviderInstance] startup report unavailable', {
        errorClass: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  });
  return bootstrapPromise;
};

export const resetIdentityProviderBootstrapForTest = (): void => {
  bootstrapPromise = null;
};
