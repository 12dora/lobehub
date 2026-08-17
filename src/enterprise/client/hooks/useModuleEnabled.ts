'use client';

import { useMemo } from 'react';

import {
  ALL_MODULES_ENABLED,
  PLATFORM_MODULE_IDS,
  type PlatformModuleId,
  type PlatformModuleStateMap,
} from '@/const/platform/modules';
import { DISABLED_PLATFORM_CAPABILITIES } from '@/types/platform/capabilities';

import { getBootModules, normalizeModuleStateMap } from '../boot/getBootModules';
import { useEnterprisePlatform } from '../providers/enterprisePlatformContext';

/**
 * Live module state for the client.
 *
 * Two sources, in order:
 *  1. `platform.getCapabilities().modules` — polled (120s while the tab is visible, plus a refresh
 *     on refocus) and therefore the freshest view an open tab can have after an admin flips a
 *     switch;
 *  2. `window.__SERVER_CONFIG__.config.enterprise.modules` — the synchronous boot payload,
 *     available before the first capability response and for anonymous/partial trees.
 *
 * **Only a *resolved* capability payload may override the boot payload.** The provider hands out
 * `DISABLED_PLATFORM_CAPABILITIES` — whose `modules` is `ALL_MODULES_ENABLED` — while the fetch
 * is pending, after it fails, and outside the provider tree. Reading that object as an answer
 * would flash every disabled module back on for as long as the request is unresolved, which on a
 * slow or offline instance is indefinitely. Identity against the shared sentinel is the exact
 * test for "no server answer yet": a real response is always a freshly parsed object, even when
 * its contents happen to match.
 *
 * Both sources fail open (missing payload ⇒ everything enabled), so an unconfigured deployment
 * and `bun run dev:spa` behave exactly like today. The server is always the real gate.
 */
export const useModuleStates = (): PlatformModuleStateMap => {
  const { capabilities } = useEnterprisePlatform();
  const resolved = capabilities !== DISABLED_PLATFORM_CAPABILITIES;
  const live: unknown = resolved ? capabilities.modules : undefined;

  return useMemo(() => {
    if (live && typeof live === 'object') return normalizeModuleStateMap(live);
    return getBootModules();
  }, [live]);
};

/** Whether a single module is enabled for this deployment. */
export const useModuleEnabled = (id: PlatformModuleId): boolean => useModuleStates()[id];

/** Ids currently disabled — the set consumed by the nav filter and the route outlet. */
export const useDisabledModules = (): ReadonlySet<PlatformModuleId> => {
  const states = useModuleStates();
  return useMemo(() => new Set(PLATFORM_MODULE_IDS.filter((id) => !states[id])), [states]);
};

export { ALL_MODULES_ENABLED };
