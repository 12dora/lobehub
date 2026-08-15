'use client';

import type { ManagedResourceKind } from '@/const/platform/managedResources';
import { useEnterprisePlatform } from '@/enterprise/client/providers/EnterprisePlatformProvider';

export const useManagedResourceCapabilities = () => {
  const platform = useEnterprisePlatform();
  return {
    capabilities: platform.capabilities.managedResources,
    error: platform.error,
    loading: platform.loading,
  };
};

/**
 * Whether the platform AI catalog currently OVERRIDES users' own provider configuration
 * (chat credentials, runtime state, settings model list, published-model allowlist).
 *
 * NOT the same as `useManagedResource('aiProviders').managed`: that is also true for the
 * `ui-only` policy, where the settings UI is blocked but the runtime stays the user's own.
 * Use this for copy that promises real user-visible effect (e.g. "this shared account is live
 * for every member").
 *
 * Fails closed while loading or on error: SWR keeps the last successful payload alongside an
 * error, so a stale `aiTakeover: true` would otherwise keep claiming the provider is serving
 * members after enforcement ended and the refresh failed. Callers that need to distinguish
 * "known false" from "unknown" can read `takeoverKnown`.
 */
export const usePlatformAiTakeover = () => {
  const platform = useEnterprisePlatform();
  const takeoverKnown = !platform.loading && platform.error === null;
  return {
    error: platform.error,
    loading: platform.loading,
    takeover: takeoverKnown && platform.capabilities.aiTakeover === true,
    takeoverKnown,
  };
};

export const useManagedResource = (resource: ManagedResourceKind) => {
  const platform = useEnterprisePlatform();
  return {
    blocked:
      platform.loading ||
      platform.error !== null ||
      platform.capabilities.managedResources[resource] === true,
    error: platform.error,
    loading: platform.loading,
    managed: platform.capabilities.managedResources[resource] === true,
    refresh: platform.refresh,
  };
};
