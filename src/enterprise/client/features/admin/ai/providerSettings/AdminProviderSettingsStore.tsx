'use client';

import { type ReactNode, useMemo } from 'react';
import { memo } from 'react';

import { adminAiInfraServices } from '@/enterprise/client/services/adminAiInfraAdapter';
import { AiInfraStoreProvider, createAiInfraStore } from '@/store/aiInfra';

/**
 * Isolated aiInfra store bound to platform admin adapter services.
 * Created once per mount of the admin provider settings surface.
 */
export const AdminProviderSettingsStoreProvider = memo<{ children: ReactNode }>(({ children }) => {
  const store = useMemo(() => createAiInfraStore(adminAiInfraServices), []);
  return <AiInfraStoreProvider store={store}>{children}</AiInfraStoreProvider>;
});

AdminProviderSettingsStoreProvider.displayName = 'AdminProviderSettingsStoreProvider';
