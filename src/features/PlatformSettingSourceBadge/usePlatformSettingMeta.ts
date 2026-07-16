'use client';

import { useCallback, useState } from 'react';
import { mutate } from 'swr';

import { useEnterprisePlatform } from '@/enterprise/client/providers/EnterprisePlatformProvider';
import { userSettingsService } from '@/enterprise/client/services/userSettings';
import { useClientDataSWR } from '@/libs/swr';
import { useUserStore } from '@/store/user';

const EFFECTIVE_KEY = 'user.settings.effective' as const;

export type PlatformSettingMetaStatus = 'disabled' | 'loading' | 'error' | 'ready';

/**
 * Path-level meta when platform policy is enabled.
 * Fail-closed: loading/error must not render editable unmanaged controls.
 */
export const usePlatformSettingMeta = (path: string) => {
  const platform = useEnterprisePlatform();
  const enabled = platform.capabilities.userSettingsPolicyEnabled === true;
  const refreshUserState = useUserStore((s) => s.refreshUserState);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  const {
    data,
    error,
    isLoading,
    mutate: revalidate,
  } = useClientDataSWR(enabled ? [EFFECTIVE_KEY] : null, () => userSettingsService.getEffective());

  const meta = data?.pathMeta[path];

  const status: PlatformSettingMetaStatus = !enabled
    ? 'disabled'
    : isLoading && !data
      ? 'loading'
      : error && !data
        ? 'error'
        : 'ready';

  const reset = useCallback(async () => {
    if (!enabled) return;
    setResetting(true);
    setResetError(null);
    try {
      await userSettingsService.resetOverride({ path });
      await mutate((key) => Array.isArray(key) && key[0] === EFFECTIVE_KEY);
      await revalidate();
      // Refresh main user state so visible values update to org default
      if (typeof refreshUserState === 'function') {
        await refreshUserState();
      }
    } catch (err) {
      setResetError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setResetting(false);
    }
  }, [enabled, path, refreshUserState, revalidate]);

  return {
    enabled,
    error,
    hidden: status === 'ready' ? (meta?.hidden ?? false) : false,
    isLoading: status === 'loading',
    locked: status === 'ready' ? (meta?.locked ?? false) : true, // fail-closed while unknown
    meta,
    mode: meta?.mode,
    reset,
    resetError,
    resetting,
    retry: () => revalidate(),
    source: meta?.source,
    status,
  };
};
