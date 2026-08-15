'use client';

import { ManagedResourceBoundary } from '@/features/ManagedResources';
import SettingsContextProvider from '@/routes/(main)/settings/_layout/ContextProvider';
import Page from '@/routes/(main)/settings/provider/(list)';

const WorkspaceProviderSetting = () => (
  <ManagedResourceBoundary resource="aiProviders">
    <SettingsContextProvider
      value={{
        showOpenAIApiKey: true,
        showOpenAIProxyUrl: true,
      }}
    >
      <Page />
    </SettingsContextProvider>
  </ManagedResourceBoundary>
);

WorkspaceProviderSetting.displayName = 'WorkspaceProviderSetting';

export default WorkspaceProviderSetting;
