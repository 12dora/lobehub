'use client';

import { memo } from 'react';

import { useAiInfraStore } from '@/store/aiInfra';
import { useElectronStore } from '@/store/electron';
import { electronSyncSelectors } from '@/store/electron/selectors';
import { serverConfigSelectors, useServerConfigStore } from '@/store/serverConfig';
import { useUserMemoryStore } from '@/store/userMemory';

interface DeferredStoreInitializationProps {
  isLogin: boolean;
}

const DeferredStoreInitialization = memo<DeferredStoreInitializationProps>(({ isLogin }) => {
  const useInitAiProviderKeyVaults = useAiInfraStore((s) => s.useFetchAiProviderRuntimeState);
  const useFetchPersona = useUserMemoryStore((s) => s.useFetchPersona);
  const isSyncActive = useElectronStore((s) => electronSyncSelectors.isSyncActive(s));
  // Deployment module switch: skip the persona fetch when the memory module is off (fail-open).
  const memoryEnabled = useServerConfigStore(
    (s) => serverConfigSelectors.enterpriseModules(s)?.memory !== false,
  );

  useInitAiProviderKeyVaults(isLogin, isSyncActive);
  useFetchPersona(isLogin && memoryEnabled);

  return null;
});

export default DeferredStoreInitialization;
