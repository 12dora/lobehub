'use client';

import { adminSidebarLayoutService } from '@/enterprise/client/services/adminSidebarLayout';
import { useClientDataSWR } from '@/libs/swr';

export const ADMIN_SIDEBAR_LAYOUT_KEY = 'admin-sidebar-layout';

export const useFetchAdminSidebarLayout = (enabled = true) =>
  useClientDataSWR(
    enabled ? [ADMIN_SIDEBAR_LAYOUT_KEY] : null,
    () => adminSidebarLayoutService.get(),
    { revalidateOnFocus: false },
  );
