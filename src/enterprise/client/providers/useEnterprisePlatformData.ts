'use client';

import { useCallback, useEffect, useRef } from 'react';

import { ADMIN_POLL_INTERVALS } from '@/enterprise/client/shared/pollIntervals';
import { mutate, useClientDataSWR } from '@/libs/swr';
import {
  DISABLED_PLATFORM_CAPABILITIES,
  type PlatformCapabilities,
} from '@/types/platform/capabilities';
import {
  DISABLED_PLATFORM_PUBLIC_SNAPSHOT,
  type PlatformPublicSnapshot,
  resolveSafePlatformPublicSnapshot,
} from '@/types/platform/publicSnapshot';

import { fetchPlatformCapabilities, fetchPlatformPublicSnapshot } from '../services/platform';

export const PLATFORM_CAPABILITIES_SWR_KEY = 'platform.getCapabilities';
export const PLATFORM_PUBLIC_SNAPSHOT_SWR_KEY = 'platform.getPublicSnapshot';
export const PLATFORM_PUBLIC_SNAPSHOT_REFRESH_INTERVAL = ADMIN_POLL_INTERVALS.publicSnapshot;
/**
 * Capabilities carry managed-resource enforcement, which decides whether whole settings trees
 * are blocked and whose credentials the chat runtime uses. `revalidateOnFocus` alone leaves a
 * user sitting on an open page on a stale answer indefinitely after an admin flips 平台托管,
 * so poll at a modest cadence (half the public-snapshot cadence's sibling — cheap, one query).
 */
export const PLATFORM_CAPABILITIES_REFRESH_INTERVAL = ADMIN_POLL_INTERVALS.capabilities;

/**
 * Second AI-cache revalidation after a managed-resource transition.
 *
 * The server memoizes the platform-AI takeover predicate for a couple of seconds, so the
 * immediate revalidation can legally still be answered from the OLD regime on an instance that
 * did not process the publish. Without a follow-up the client would keep that answer forever:
 * the runtime-state SWR has no polling interval and the capability signal no longer changes.
 * Must comfortably exceed the server memo horizon.
 */
export const AI_CACHE_TRANSITION_SETTLE_DELAY = 6_000;

/**
 * SWR key prefixes of the aiInfra caches whose CONTENT depends on server-side platform
 * takeover: the provider list / runtime state (`FETCH_AI_PROVIDER*`, incl. the scoped admin
 * variants) and the per-provider model list (`aiModel:*`).
 *
 * Matches raw keys in every shape they are written in: bare string, `scope:KEY` string,
 * `[KEY, …]` tuple, `[scope, KEY, …]` tuple, and the workspace-augmented tuples produced by
 * `augmentKey`.
 */
const AI_INFRA_SWR_KEY_PREFIXES = ['FETCH_AI_PROVIDER', 'aiModel:'] as const;

export const isAiInfraPlatformSensitiveSwrKey = (key: unknown): boolean => {
  const parts: unknown[] = Array.isArray(key) ? key : [key];
  return parts.some(
    (part) =>
      typeof part === 'string' &&
      AI_INFRA_SWR_KEY_PREFIXES.some(
        (prefix) => part.startsWith(prefix) || part.includes(`:${prefix}`),
      ),
  );
};

export interface UseEnterprisePlatformDataOptions {
  disableFetch: boolean;
  enterpriseEnabled: boolean;
  fetchCapabilities?: typeof fetchPlatformCapabilities;
  fetchPublicSnapshot?: typeof fetchPlatformPublicSnapshot;
  initialPublicSnapshot?: PlatformPublicSnapshot;
  /**
   * Whether a user session exists. `platform.getCapabilities` is an authenticated
   * procedure, so an anonymous visitor must not poll it — enterprise features are on
   * by default now, so without this the sign-in page would 401 on a 60s loop.
   * The public snapshot (branding / login options) is unauthenticated and still loads.
   */
  isSignedIn?: boolean;
  serverConfigInit: boolean;
}

export interface EnterprisePlatformData {
  capabilities: PlatformCapabilities;
  error: Error | null;
  loading: boolean;
  publicSnapshot: PlatformPublicSnapshot;
  refresh: () => Promise<void>;
}

const toError = (error: unknown): Error | null => {
  if (!error) return null;
  return error instanceof Error ? error : new Error(String(error));
};

/** SWR-backed bootstrap with a synchronous built-in fallback and revision polling. */
export const useEnterprisePlatformData = ({
  disableFetch,
  enterpriseEnabled,
  fetchCapabilities = fetchPlatformCapabilities,
  fetchPublicSnapshot = fetchPlatformPublicSnapshot,
  initialPublicSnapshot = DISABLED_PLATFORM_PUBLIC_SNAPSHOT,
  isSignedIn = true,
  serverConfigInit,
}: UseEnterprisePlatformDataOptions): EnterprisePlatformData => {
  const enabled = !disableFetch && serverConfigInit && enterpriseEnabled;
  // Capabilities need a session; the public snapshot does not.
  const capabilitiesEnabled = enabled && isSignedIn;
  const safeInitialPublicSnapshot = resolveSafePlatformPublicSnapshot(initialPublicSnapshot);
  const publicSnapshotKey = enabled
    ? ([
        PLATFORM_PUBLIC_SNAPSHOT_SWR_KEY,
        safeInitialPublicSnapshot.configRevision,
        safeInitialPublicSnapshot.brandingRevision,
      ] as const)
    : null;
  const capabilitiesFetcher = useCallback(() => fetchCapabilities(), [fetchCapabilities]);
  const publicSnapshotFetcher = useCallback(() => fetchPublicSnapshot(), [fetchPublicSnapshot]);
  const capabilitiesSWR = useClientDataSWR<PlatformCapabilities>(
    capabilitiesEnabled ? PLATFORM_CAPABILITIES_SWR_KEY : null,
    capabilitiesFetcher,
    {
      fallbackData: DISABLED_PLATFORM_CAPABILITIES,
      refreshInterval: PLATFORM_CAPABILITIES_REFRESH_INTERVAL,
      revalidateOnFocus: true,
    },
  );
  const publicSnapshotSWR = useClientDataSWR<PlatformPublicSnapshot>(
    publicSnapshotKey,
    publicSnapshotFetcher,
    {
      dedupingInterval: PLATFORM_PUBLIC_SNAPSHOT_REFRESH_INTERVAL,
      fallbackData: safeInitialPublicSnapshot,
      refreshInterval: PLATFORM_PUBLIC_SNAPSHOT_REFRESH_INTERVAL,
      revalidateOnFocus: true,
    },
  );

  const refresh = useCallback(async () => {
    if (!enabled) return;
    await Promise.all([capabilitiesSWR.mutate(), publicSnapshotSWR.mutate()]);
  }, [capabilitiesSWR, enabled, publicSnapshotSWR]);

  // When 平台托管 for AI providers starts or ends, the server answers `getAiProviderRuntimeState`
  // / `getAiProviderModelList` with a *different* catalog (platform ⇄ the user's own). Those
  // caches carry no capability in their key, so nothing else would invalidate them — the user
  // would keep seeing (and the picker keep offering) the previous regime's providers until a
  // reload.
  //
  // The signal is `aiTakeover` — the server's own runtime-takeover predicate — plus the
  // managed-resource policy REVISION (`configRevision`) and the UI-blocking `aiProviders`
  // flag. `aiTakeover` is the precise trigger (`managedResources.aiProviders` is also true for
  // `ui-only`, where the UI is blocked but the runtime is NOT taken over, so `enforced →
  // ui-only` would otherwise be invisible); the revision and the flag are kept so any other
  // policy or readiness-driven capability change also refreshes. Only fire on a real
  // transition, never on the first observed value.
  const capabilitySignal = capabilitiesSWR.data
    ? [
        capabilitiesSWR.data.aiTakeover === true,
        capabilitiesSWR.data.managedResources?.aiProviders === true,
        capabilitiesSWR.data.configRevision,
      ].join('|')
    : null;
  const previousCapabilitySignal = useRef<string | null>(null);
  useEffect(() => {
    if (capabilitySignal === null) return;
    const previous = previousCapabilitySignal.current;
    previousCapabilitySignal.current = capabilitySignal;
    if (previous === null || previous === capabilitySignal) return;

    void mutate(isAiInfraPlatformSensitiveSwrKey);
    // …and once more past the server's takeover memo horizon, so a first fetch answered from a
    // stale memo cannot become the permanently cached regime.
    const timer = setTimeout(() => {
      void mutate(isAiInfraPlatformSensitiveSwrKey);
    }, AI_CACHE_TRANSITION_SETTLE_DELAY);
    return () => clearTimeout(timer);
  }, [capabilitySignal]);

  if (!enabled) {
    return {
      capabilities: DISABLED_PLATFORM_CAPABILITIES,
      error: null,
      loading: false,
      publicSnapshot: safeInitialPublicSnapshot,
      refresh,
    };
  }

  return {
    capabilities: capabilitiesSWR.data ?? DISABLED_PLATFORM_CAPABILITIES,
    error: toError(capabilitiesSWR.error ?? publicSnapshotSWR.error),
    loading: Boolean(capabilitiesSWR.isLoading || publicSnapshotSWR.isLoading),
    publicSnapshot: resolveSafePlatformPublicSnapshot(
      publicSnapshotSWR.data ?? safeInitialPublicSnapshot,
    ),
    refresh,
  };
};
