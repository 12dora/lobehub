'use client';

import { Text } from '@lobehub/ui';
import { createStaticStyles } from 'antd-style';
import { memo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';

import AdminAiRuntimeLoadAlert from '@/enterprise/client/features/admin/ai/shared/AdminAiRuntimeLoadAlert';
import SettingContainer from '@/features/Setting/SettingContainer';
import SettingsContextProvider from '@/routes/(main)/settings/_layout/ContextProvider';
import ProviderGrid from '@/routes/(main)/settings/provider/(list)/ProviderGrid';
import ProviderDetailPageComponent from '@/routes/(main)/settings/provider/detail';
import { ProviderSettingsContext } from '@/routes/(main)/settings/provider/features/ModelList/ProviderSettingsContext';
import ProviderMenu from '@/routes/(main)/settings/provider/ProviderMenu';
import { useScopedAiInfraStore as useAiInfraStore } from '@/store/aiInfra';

import { AdminProviderSettingsStoreProvider } from './AdminProviderSettingsStore';
import SharedOAuthConnect from './SharedOAuthConnect';

const styles = createStaticStyles(({ css }) => ({
  body: css`
    overflow: hidden;
    display: flex;
    flex: 1;
    min-height: 0;
  `,
  shell: css`
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  `,
  toolbar: css`
    display: flex;
    flex-shrink: 0;
    gap: 12px;
    align-items: center;

    padding-block: 8px 12px;
    padding-inline: 4px;
  `,
}));

const renderSharedOAuthPanel = (providerId: string) => (
  <SharedOAuthConnect key={providerId} providerId={providerId} />
);

/**
 * Sync secretConfigured + admin UI flags into ProviderSettingsContext from active detail.
 */
const AdminProviderSettingsContextBridge = memo<{ children: React.ReactNode }>(({ children }) => {
  const { t } = useTranslation('admin');
  const activeId = useAiInfraStore((s) => s.activeAiProvider);
  const detail = useAiInfraStore((s) => (activeId ? s.aiProviderDetailMap[activeId] : undefined));
  const secretConfigured = Boolean(
    (detail as { secretConfigured?: boolean } | undefined)?.secretConfigured,
  );

  return (
    <ProviderSettingsContext
      value={{
        // Platform delete is a true hard delete for everyone — say so, instead of reusing the
        // personal-provider copy that only describes the viewer's own settings.
        deleteConfirmDescription: t('aiProviderSettings.deleteConfirmDescription'),
        hideFetchOnClient: true,
        // Personal OAuth connects write to the viewer's own key vault — never offer them
        // on the platform catalog surface.
        hidePersonalAuth: true,
        modelEditable: true,
        secretConfigured,
        // Platform-owned shared account connect for rotating-refresh providers.
        sharedOAuthPanel: renderSharedOAuthPanel,
        showAddNewModel: true,
        // Remote model fetch is user-key based; hide for platform catalog.
        showModelFetcher: false,
      }}
    >
      {children}
    </ProviderSettingsContext>
  );
});

const AdminProviderSettingsLayout = memo(() => {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();
  const params = useParams<{ id?: string }>();
  const useFetchAiProviderList = useAiInfraStore((s) => s.useFetchAiProviderList);
  const useFetchRuntime = useAiInfraStore((s) => s.useFetchAiProviderRuntimeState);

  // Admin is always authenticated when this page is reachable.
  useFetchAiProviderList({ enabled: true });
  const { error: runtimeError, mutate: mutateRuntime } = useFetchRuntime(true);
  const retryRuntime = useCallback(() => mutateRuntime(), [mutateRuntime]);

  const id = params.id;
  const onProviderSelect = (providerKey: string) => {
    navigate(`/admin/ai/providers/${encodeURIComponent(providerKey)}`);
  };

  return (
    <div className={styles.shell}>
      <div className={styles.toolbar}>
        <div>
          <Text as="h1" style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>
            {t('nav.aiProviders')}
          </Text>
          <Text style={{ fontSize: 12 }} type="secondary">
            {t('aiProviderSettings.description', {
              defaultValue: 'Manage global platform AI providers. Changes apply immediately.',
            })}
          </Text>
        </div>
      </div>
      <div className={styles.body}>
        <ProviderMenu mobile={false} onProviderSelect={onProviderSelect} />
        <SettingContainer flex={1} maxWidth={1024} padding={24} style={{ minHeight: 0 }}>
          {runtimeError ? (
            <AdminAiRuntimeLoadAlert error={runtimeError} onRetry={retryRuntime} />
          ) : null}
          {id ? (
            <ProviderDetailPageComponent id={id} onProviderSelect={onProviderSelect} />
          ) : (
            <ProviderGrid onProviderSelect={onProviderSelect} />
          )}
        </SettingContainer>
      </div>
    </div>
  );
});

/**
 * Admin parity page for `/admin/ai/providers` (+ `/:id`).
 * Reuses user settings provider UI; data source is platform catalog via adapter.
 * Does NOT wrap ManagedResourceBoundary (admin is the managed owner).
 */
const ProviderSettingsPage = memo(() => (
  <AdminProviderSettingsStoreProvider>
    <AdminProviderSettingsContextBridge>
      {/* Provide the settings context the user-side OpenAI detail consumes; without it
          `useSettingsContext()` throws and AdminErrorBoundary shows 管理后台错误. */}
      <SettingsContextProvider value={{ showOpenAIApiKey: true, showOpenAIProxyUrl: true }}>
        <AdminProviderSettingsLayout />
      </SettingsContextProvider>
    </AdminProviderSettingsContextBridge>
  </AdminProviderSettingsStoreProvider>
));

ProviderSettingsPage.displayName = 'AdminProviderSettingsPage';

export default ProviderSettingsPage;
