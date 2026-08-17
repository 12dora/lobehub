'use client';

import { useEnterprisePlatform } from '@/enterprise/client/providers/EnterprisePlatformProvider';
import { adminSettingsService } from '@/enterprise/client/services/adminSettings';
import { mutate, useClientDataSWR } from '@/libs/swr';

import { ADMIN_SETTINGS_DRAFT_KEY, buildAdminSettingsDraftKey } from '../swrKeys';

/**
 * Fetch admin settings draft only when platform settings policy capability is ON.
 * Hardcoded `true` is forbidden — Flag OFF must issue zero getDraft requests (U1).
 */
export const useFetchAdminSettingsDraft = (enabled = true) => {
  const platform = useEnterprisePlatform();
  const policyOn = platform.capabilities.userSettingsPolicyEnabled === true;
  const key = shouldFetchAdminSettingsDraft({
    enabled,
    userSettingsPolicyEnabled: policyOn,
  })
    ? buildAdminSettingsDraftKey()
    : null;
  return useClientDataSWR(key, () => adminSettingsService.getDraft());
};

/** Test helper: pure key decision for zero-call regression. */
export const shouldFetchAdminSettingsDraft = (params: {
  enabled: boolean;
  userSettingsPolicyEnabled: boolean;
}): boolean => params.enabled && params.userSettingsPolicyEnabled;

export const refreshAdminSettingsDraft = async () => {
  await mutate((key) => Array.isArray(key) && key[0] === ADMIN_SETTINGS_DRAFT_KEY);
};
