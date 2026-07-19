'use client';

import { mutate } from 'swr';

import { useEnterprisePlatform } from '@/enterprise/client/providers/EnterprisePlatformProvider';
import { adminBrandingService } from '@/enterprise/client/services/adminBranding';
import { useClientDataSWR } from '@/libs/swr';

export const ADMIN_BRANDING_DRAFT_KEY = 'admin.branding.getDraft';

export const shouldFetchAdminBranding = (params: {
  adminAllowed: boolean;
  brandingEnabled: boolean;
  canRead: boolean;
}): boolean => params.adminAllowed && params.brandingEnabled && params.canRead;

export const useFetchAdminBranding = (params: { adminAllowed: boolean; canRead: boolean }) => {
  const platform = useEnterprisePlatform();
  const enabled = shouldFetchAdminBranding({
    adminAllowed: params.adminAllowed,
    brandingEnabled: platform.capabilities.features.runtimeBranding === true,
    canRead: params.canRead,
  });
  return useClientDataSWR(enabled ? [ADMIN_BRANDING_DRAFT_KEY] : null, () =>
    adminBrandingService.getDraft(),
  );
};

export const refreshAdminBranding = async (): Promise<void> => {
  await mutate((key) => Array.isArray(key) && key[0] === ADMIN_BRANDING_DRAFT_KEY);
};
