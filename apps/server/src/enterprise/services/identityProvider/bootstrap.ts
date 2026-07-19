import { loadIdentityProviderStartupSnapshot } from './startupSnapshot';

let bootstrapPromise: Promise<void> | null = null;

/** The node instrumentation hook is the sole production owner of startup loading. */
export const bootstrapIdentityProviderRuntime = (): Promise<void> => {
  bootstrapPromise ??= loadIdentityProviderStartupSnapshot().then(() => undefined);
  return bootstrapPromise;
};

export const resetIdentityProviderBootstrapForTest = (): void => {
  bootstrapPromise = null;
};
