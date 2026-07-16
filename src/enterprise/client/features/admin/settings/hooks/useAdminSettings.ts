'use client';

import { mutate } from 'swr';

import { adminSettingsService } from '@/enterprise/client/services/adminSettings';
import { useClientDataSWR } from '@/libs/swr';

import { ADMIN_SETTINGS_DRAFT_KEY, buildAdminSettingsDraftKey } from '../swrKeys';

export const useFetchAdminSettingsDraft = (enabled = true) => {
  const key = enabled ? buildAdminSettingsDraftKey() : null;
  return useClientDataSWR(key, () => adminSettingsService.getDraft());
};

export const refreshAdminSettingsDraft = async () => {
  await mutate((key) => Array.isArray(key) && key[0] === ADMIN_SETTINGS_DRAFT_KEY);
};
