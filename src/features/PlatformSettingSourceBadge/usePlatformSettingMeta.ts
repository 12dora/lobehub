'use client';

import { useCallback } from 'react';
import { mutate } from 'swr';

import { useEnterprisePlatform } from '@/enterprise/client/providers/EnterprisePlatformProvider';
import { userSettingsService } from '@/enterprise/client/services/userSettings';
import { useClientDataSWR } from '@/libs/swr';

const EFFECTIVE_KEY = 'user.settings.effective' as const;

/**
 * Path-level meta for registered settings when platform policy is enabled.
 * When flag/capability is off, returns undefined meta (no platform.* request).
 */
export const usePlatformSettingMeta = (path: string) => {
  const platform = useEnterprisePlatform();
  const enabled = platform.capabilities.userSettingsPolicyEnabled === true;

  const {
    data,
    error,
    isLoading,
    mutate: revalidate,
  } = useClientDataSWR(enabled ? [EFFECTIVE_KEY] : null, () => userSettingsService.getEffective());

  const meta = data?.pathMeta[path];

  const reset = useCallback(async () => {
    if (!enabled) return;
    await userSettingsService.resetOverride({ path });
    await mutate((key) => Array.isArray(key) && key[0] === EFFECTIVE_KEY);
    await revalidate();
  }, [enabled, path, revalidate]);

  return {
    enabled,
    error,
    hidden: meta?.hidden ?? false,
    isLoading,
    locked: meta?.locked ?? false,
    meta,
    mode: meta?.mode,
    reset,
    source: meta?.source,
  };
};
