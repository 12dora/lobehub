'use client';

import { adminAuthSettingsService } from '@/enterprise/client/services/adminAuthSettings';
import { useClientDataSWR } from '@/libs/swr';

export const ADMIN_AUTH_SETTINGS_KEY = 'admin-auth-settings';

export const useFetchAdminAuthSettings = (enabled = true) =>
  useClientDataSWR(
    enabled ? [ADMIN_AUTH_SETTINGS_KEY] : null,
    () => adminAuthSettingsService.get(),
    { revalidateOnFocus: false },
  );
