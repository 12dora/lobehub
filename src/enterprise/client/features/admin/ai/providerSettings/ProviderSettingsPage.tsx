'use client';

import { Text } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';

import ProviderGrid from '@/routes/(main)/settings/provider/(list)/ProviderGrid';
import ProviderDetailPageComponent from '@/routes/(main)/settings/provider/detail';
import { ProviderSettingsContext } from '@/routes/(main)/settings/provider/features/ModelList/ProviderSettingsContext';
import ProviderMenu from '@/routes/(main)/settings/provider/ProviderMenu';
import { useScopedAiInfraStore as useAiInfraStore } from '@/store/aiInfra';

import { AdminProviderSettingsStoreProvider } from './AdminProviderSettingsStore';

const styles = createStaticStyles(({ css }) => ({
  advancedLink: css`
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
    text-decoration: none;

    &:hover {
      color: ${cssVar.colorTextSecondary};
    }
  `,
  body: css`
    overflow: hidden;
    display: flex;
    flex: 1;
    min-height: 0;
  `,
  content: css`
    overflow: auto;
    flex: 1;

    min-width: 0;
    padding-block: 16px 24px;
    padding-inline: 24px;
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
    justify-content: space-between;

    padding-block: 8px 12px;
    padding-inline: 4px;
  `,
}));

const AdvancedCatalogLink = memo(() => {
  const { t } = useTranslation('admin');
  return (
    <Link className={styles.advancedLink} to="/admin/ai/catalog/providers">
      {t('aiProviderSettings.advancedCatalog', {
        defaultValue: 'Advanced catalog management',
      })}
    </Link>
  );
});

/**
 * Sync secretConfigured + admin UI flags into ProviderSettingsContext from active detail.
 */
const AdminProviderSettingsContextBridge = memo<{ children: React.ReactNode }>(({ children }) => {
  const activeId = useAiInfraStore((s) => s.activeAiProvider);
  const detail = useAiInfraStore((s) => (activeId ? s.aiProviderDetailMap[activeId] : undefined));
  const secretConfigured = Boolean(
    (detail as { secretConfigured?: boolean } | undefined)?.secretConfigured,
  );

  return (
    <ProviderSettingsContext
      value={{
        hideFetchOnClient: true,
        modelEditable: true,
        secretConfigured,
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
  useFetchRuntime(true);

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
              defaultValue: 'Manage global platform AI providers. Changes publish immediately.',
            })}
          </Text>
        </div>
        <AdvancedCatalogLink />
      </div>
      <div className={styles.body}>
        <ProviderMenu mobile={false} onProviderSelect={onProviderSelect} />
        <div className={styles.content}>
          {id ? (
            <ProviderDetailPageComponent id={id} onProviderSelect={onProviderSelect} />
          ) : (
            <ProviderGrid onProviderSelect={onProviderSelect} />
          )}
        </div>
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
      <AdminProviderSettingsLayout />
    </AdminProviderSettingsContextBridge>
  </AdminProviderSettingsStoreProvider>
));

ProviderSettingsPage.displayName = 'AdminProviderSettingsPage';

export default ProviderSettingsPage;
