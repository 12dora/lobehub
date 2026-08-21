'use client';

import { useEffect } from 'react';

import {
  EFFECTIVE_SETTINGS_SWR_KEY,
  markPlatformSettingLocksUnknown,
  markPlatformSettingsUnmanaged,
  publishPlatformSettingLocks,
} from '@/helpers/platformSettingLocks';
import { mutate } from '@/libs/swr';

import { userSettingsService } from '../services/userSettings';

export interface PlatformSettingLockSyncParams {
  /** `platform.getCapabilities` answered (false while the bootstrap fetch is in flight). */
  capabilitiesReady: boolean;
  /** Any enterprise env flag is on for this deployment. */
  enterpriseEnabled: boolean;
  /** A session exists — the effective-settings query is authenticated. */
  isSignedIn: boolean;
  /** Identity of the signed-in account / policy revision; a change re-primes. */
  policyIdentity: string;
  /** `serverConfig.getGlobalConfig` has hydrated. */
  serverConfigInit: boolean;
  /** `capabilities.userSettingsPolicyEnabled === true`. */
  userSettingsPolicyEnabled: boolean;
}

/**
 * Keeps the non-React platform lock mirror in sync from **platform bootstrap**,
 * not from whichever managed field happens to be mounted.
 *
 * Without this, a chat send that happens before any `usePlatformSettingMeta`
 * consumer has resolved would read an empty mirror and could let a
 * per-conversation override beat a locked organisation policy. The mirror
 * therefore stays `unknown` (callers fail closed) until this hook can prove the
 * deployment is unmanaged or has answered with real `pathMeta`.
 */
export const usePlatformSettingLockSync = ({
  capabilitiesReady,
  enterpriseEnabled,
  isSignedIn,
  policyIdentity,
  serverConfigInit,
  userSettingsPolicyEnabled,
}: PlatformSettingLockSyncParams): void => {
  useEffect(() => {
    // Nothing is known about the deployment yet.
    if (!serverConfigInit) {
      markPlatformSettingLocksUnknown();
      return;
    }

    // No enterprise build / flags, or no session to carry a policy: no path can
    // be locked, so unmanaged resolution is exact (and matches flag-off).
    if (!enterpriseEnabled || !isSignedIn) {
      markPlatformSettingsUnmanaged();
      return;
    }

    // Capabilities still loading — the DISABLED fallback must not be mistaken
    // for a real "policy is off" answer.
    if (!capabilitiesReady) {
      markPlatformSettingLocksUnknown();
      return;
    }

    if (!userSettingsPolicyEnabled) {
      markPlatformSettingsUnmanaged();
      return;
    }

    // Policy is on: the mirror is only trustworthy once pathMeta is answered.
    // Reset first so an account/policy change cannot leave the previous
    // account's locks readable while the new answer is in flight.
    markPlatformSettingLocksUnknown();

    let cancelled = false;
    void mutate(
      [EFFECTIVE_SETTINGS_SWR_KEY],
      async () => {
        const effective = await userSettingsService.getEffective();
        if (!cancelled) publishPlatformSettingLocks(effective.pathMeta);
        return effective;
      },
      { revalidate: false },
      // A failed prime leaves the mirror `unknown`, which is the safe state.
    ).catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [
    capabilitiesReady,
    enterpriseEnabled,
    isSignedIn,
    policyIdentity,
    serverConfigInit,
    userSettingsPolicyEnabled,
  ]);
};
