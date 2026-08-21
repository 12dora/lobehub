'use client';

import { useCallback, useRef, useState } from 'react';

import { useEnterprisePlatform } from '@/enterprise/client/providers/EnterprisePlatformProvider';
import { userSettingsService } from '@/enterprise/client/services/userSettings';
import {
  EFFECTIVE_SETTINGS_SWR_KEY,
  publishPlatformSettingLocks,
} from '@/helpers/platformSettingLocks';
import { useClientDataSWR } from '@/libs/swr';
import type { UserSettingsGetEffectiveOutput } from '@/server/enterprise/contracts/userSettings';
import { useUserStore } from '@/store/user';

const EFFECTIVE_KEY = EFFECTIVE_SETTINGS_SWR_KEY;

export type PlatformSettingMetaStatus = 'disabled' | 'loading' | 'error' | 'ready';

export interface PlatformSettingMetaState {
  canReset: boolean;
  enabled: boolean;
  error: Error | undefined;
  hidden: boolean;
  isLoading: boolean;
  locked: boolean;
  meta: UserSettingsGetEffectiveOutput['pathMeta'][string] | undefined;
  mode: 'default' | 'locked' | 'user' | undefined;
  reset: () => Promise<boolean>;
  resetError: Error | null;
  resetting: boolean;
  retry: () => Promise<UserSettingsGetEffectiveOutput | undefined>;
  source: 'builtin' | 'environment' | 'legacy' | 'platform' | 'user' | undefined;
  status: PlatformSettingMetaStatus;
}

export const isPlatformSettingMetaWritable = (meta: PlatformSettingMetaState): boolean =>
  meta.status === 'disabled' || (meta.status === 'ready' && !meta.hidden && !meta.locked);

/**
 * Path-level meta when platform policy is enabled.
 * Fail-closed: loading/error must not render editable unmanaged controls.
 */
export const usePlatformSettingMeta = (
  path: string,
  registered = true,
): PlatformSettingMetaState => {
  const platform = useEnterprisePlatform();
  const enabled = registered && platform.capabilities.userSettingsPolicyEnabled === true;
  const refreshUserState = useUserStore((s) => s.refreshUserState);
  const resetInFlightRef = useRef(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<Error | null>(null);

  const {
    data,
    error,
    mutate: revalidate,
  } = useClientDataSWR(enabled ? [EFFECTIVE_KEY] : null, async () => {
    const effective = await userSettingsService.getEffective();
    // Mirror the locked paths for non-React readers (store actions / agent-run
    // transports) that must fail closed on a managed policy.
    publishPlatformSettingLocks(effective.pathMeta);
    return effective;
  });

  const meta = data?.pathMeta[path];

  const status: PlatformSettingMetaStatus = !enabled
    ? 'disabled'
    : data
      ? 'ready'
      : error
        ? 'error'
        : 'loading';

  const canReset =
    status === 'ready' && meta?.mode === 'default' && meta.source === 'user' && !meta.locked;

  const reset = useCallback(async () => {
    if (!canReset || resetInFlightRef.current) return false;

    resetInFlightRef.current = true;
    setResetting(true);
    setResetError(null);
    try {
      await userSettingsService.resetOverride({ path });
      await revalidate();
      await refreshUserState();
      return true;
    } catch (err) {
      setResetError(err instanceof Error ? err : new Error(String(err)));
      return false;
    } finally {
      resetInFlightRef.current = false;
      setResetting(false);
    }
  }, [canReset, path, refreshUserState, revalidate]);

  // U1-R2: flag OFF → exact unmanaged (not locked/hidden); loading/error fail-closed for management
  const unmanaged = status === 'disabled';
  const ready = status === 'ready';

  return {
    canReset,
    enabled,
    error: error instanceof Error ? error : error ? new Error(String(error)) : undefined,
    hidden: unmanaged ? false : ready ? (meta?.hidden ?? false) : false,
    isLoading: status === 'loading',
    // disabled: unlocked; ready: meta; loading/error: fail-closed locked for write surfaces
    locked: unmanaged ? false : ready ? (meta?.locked ?? true) : true,
    meta: unmanaged ? undefined : meta,
    mode: unmanaged ? undefined : meta?.mode,
    reset,
    resetError,
    resetting,
    retry: async () => revalidate(),
    source: unmanaged ? undefined : meta?.source,
    status,
  };
};
