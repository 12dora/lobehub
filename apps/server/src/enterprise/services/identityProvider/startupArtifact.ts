import type { RuntimeIdentityProvider } from '@/libs/better-auth/sso/platformIdentityProvider';

export type IdentityProviderStartupSource = 'break_glass' | 'database' | 'environment' | 'lkg';
export type IdentityProviderStartupPhase = 'degraded' | 'loading' | 'ready' | 'uninitialized';

export interface IdentityProviderStartupHealth {
  generation: string | null;
  health: 'degraded' | 'healthy';
  identityRevision: string | null;
  lastError: string | null;
  loadedAt: Date;
  source: IdentityProviderStartupSource;
}

export interface IdentityProviderStartupSnapshot extends IdentityProviderStartupHealth {
  databaseProviders: RuntimeIdentityProvider[];
  providerIds: string[];
}

export interface IdentityProviderPublicArtifact extends IdentityProviderStartupHealth {
  phase: IdentityProviderStartupPhase;
  providerIds: string[];
}

export interface IdentityProviderRuntimeArtifact {
  databaseProviders: RuntimeIdentityProvider[];
  phase: IdentityProviderStartupPhase;
  providerIds: string[];
}

let phase: IdentityProviderStartupPhase = 'uninitialized';
let snapshot: IdentityProviderStartupSnapshot | null = null;

const environmentProviderIds = (env: Record<string, string | undefined>): string[] => [
  ...new Set(
    (env.AUTH_SSO_PROVIDERS ?? '')
      .split(',')
      .map((provider) => provider.trim().toLowerCase())
      .filter(Boolean),
  ),
];

const fallbackHealth = (): IdentityProviderStartupHealth => ({
  generation: null,
  health: 'degraded',
  identityRevision: null,
  lastError: phase === 'loading' ? 'startup_snapshot_loading' : 'startup_snapshot_not_initialized',
  loadedAt: new Date(0),
  source: 'break_glass',
});

export const markIdentityProviderStartupLoading = (): void => {
  if (!snapshot) phase = 'loading';
};

export const commitIdentityProviderStartupSnapshot = (
  next: IdentityProviderStartupSnapshot,
): void => {
  snapshot = next;
  phase = next.health === 'healthy' ? 'ready' : 'degraded';
};

export const commitIdentityProviderStartupFailure = (
  env: Record<string, string | undefined> = process.env,
): IdentityProviderStartupSnapshot => {
  const failed: IdentityProviderStartupSnapshot = {
    ...fallbackHealth(),
    databaseProviders: [],
    lastError: 'startup_snapshot_initialization_failed',
    loadedAt: new Date(),
    providerIds: environmentProviderIds(env),
  };
  snapshot = failed;
  phase = 'degraded';
  return failed;
};

export const getIdentityProviderPublicArtifact = (
  env: Record<string, string | undefined> = process.env,
): IdentityProviderPublicArtifact => {
  if (!snapshot) {
    return {
      ...fallbackHealth(),
      phase,
      providerIds: environmentProviderIds(env),
    };
  }
  const { databaseProviders: _, ...publicSnapshot } = snapshot;
  return { ...publicSnapshot, phase };
};

export const getIdentityProviderRuntimeArtifact = (
  env: Record<string, string | undefined> = process.env,
): IdentityProviderRuntimeArtifact => ({
  databaseProviders: snapshot?.databaseProviders ?? [],
  phase,
  providerIds: snapshot?.providerIds ?? environmentProviderIds(env),
});

const assertInitialized = (): void => {
  if (!snapshot || phase === 'loading' || phase === 'uninitialized') {
    throw new Error('PLATFORM_IDENTITY_PROVIDER_STARTUP_NOT_INITIALIZED');
  }
};

export const getInitializedIdentityProviderPublicArtifact = (): IdentityProviderPublicArtifact => {
  assertInitialized();
  return getIdentityProviderPublicArtifact();
};

export const getInitializedIdentityProviderRuntimeArtifact =
  (): IdentityProviderRuntimeArtifact => {
    assertInitialized();
    return getIdentityProviderRuntimeArtifact();
  };

export const getIdentityProviderStartupArtifactHealth = (): IdentityProviderStartupHealth | null =>
  snapshot
    ? {
        generation: snapshot.generation,
        health: snapshot.health,
        identityRevision: snapshot.identityRevision,
        lastError: snapshot.lastError,
        loadedAt: snapshot.loadedAt,
        source: snapshot.source,
      }
    : null;

export const resetIdentityProviderStartupArtifactForTest = (): void => {
  phase = 'uninitialized';
  snapshot = null;
};
