'use client';

import { Flexbox, Text } from '@lobehub/ui';
import { Tabs } from '@lobehub/ui/base-ui';
import { memo, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import { deriveAdminSystemPermissions } from '@/enterprise/client/features/admin/system/controller';
import { useModuleEnabled } from '@/enterprise/client/hooks/useModuleEnabled';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import { adminSystemService } from '@/enterprise/client/services/adminSystem';

import NetworkProxyTab from '../networkProxy/NetworkProxyTab';
import { deriveNetworkProxyPermissions } from '../networkProxy/permissions';
import AdminPageTemplate from '../primitives/AdminPageTemplate';
import {
  useAdminBrowserProfile,
  useAdminBrowserProfileOptions,
  useAdminInfraSettings,
  useInfraDependencyProbe,
} from './hooks';
import type { BrowserProfileSaveInput } from './infra/browserProfileSelection';
import { SystemGeneralPageView } from './SystemGeneralPageView';

export const SYSTEM_GENERAL_TABS = ['infrastructure', 'network-proxy'] as const;
export type SystemGeneralTab = (typeof SYSTEM_GENERAL_TABS)[number];

const isSystemGeneralTab = (value: string | null): value is SystemGeneralTab =>
  value !== null && (SYSTEM_GENERAL_TABS as readonly string[]).includes(value);

/**
 * 系统 → 通用设置 (design §6): 基础设施 | 网络代理.
 *
 * The two tabs are gated independently — infrastructure on SYSTEM_READ, network proxy on
 * NETWORK_PROXY_READ — so a tab is only offered to an admin who can actually open it, and the
 * active tab rides in `?tab=` so the page can be linked to directly.
 */
const SystemGeneralPage = memo(() => {
  const { t } = useTranslation('admin');
  const { permissions, status: accessStatus } = useAdminAccess();
  const [params, setParams] = useSearchParams();

  const { canOperate, canRead } = deriveAdminSystemPermissions(permissions);
  const rawProxy = deriveNetworkProxyPermissions(permissions);
  // 网络代理 is an optional module: when the deployment switched it off the tab must disappear
  // exactly like a missing permission does, rather than offer a page that answers FORBIDDEN.
  const networkProxyModule = useModuleEnabled('networkProxy');
  const proxy = {
    ...rawProxy,
    canManage: rawProxy.canManage && networkProxyModule,
    canRead: rawProxy.canRead && networkProxyModule,
  };
  const allowed = accessStatus === 'allowed';

  const raw = params.get('tab');
  const requested: SystemGeneralTab = isSystemGeneralTab(raw) ? raw : 'infrastructure';
  // Never strand an admin on a tab they cannot read.
  const tab: SystemGeneralTab =
    requested === 'network-proxy' && !proxy.canRead
      ? 'infrastructure'
      : requested === 'infrastructure' && !canRead && proxy.canRead
        ? 'network-proxy'
        : requested;

  const infraEnabled = allowed && canRead && tab === 'infrastructure';
  const settings = useAdminInfraSettings(infraEnabled, adminSystemService);
  const browserProfile = useAdminBrowserProfile(infraEnabled, adminSystemService);
  // Read permission, not operate: the pools also name the GPU the card reports read-only.
  const browserProfileOptions = useAdminBrowserProfileOptions(infraEnabled, adminSystemService);
  const probe = useInfraDependencyProbe(adminSystemService);

  /**
   * Both writes answer with the summary they produced, so the card is fed that rather than a
   * follow-up read: a revalidation that fails transiently would otherwise leave a saved choice
   * looking unsaved, and the operator would write the same selection a second time.
   */
  const regenerateBrowserProfile = useCallback(async () => {
    const summary = await adminSystemService.regenerateBrowserProfile({});
    await browserProfile.mutate(summary, { revalidate: false });
  }, [browserProfile]);

  const saveBrowserProfile = useCallback(
    async (input: BrowserProfileSaveInput) => {
      const summary = await adminSystemService.updateBrowserProfile(input);
      await browserProfile.mutate(summary, { revalidate: false });
    },
    [browserProfile],
  );

  const tabs = useMemo(
    () =>
      [
        ...(canRead
          ? [{ key: 'infrastructure', label: t('systemGeneral.tabs.infrastructure') }]
          : []),
        ...(proxy.canRead
          ? [{ key: 'network-proxy', label: t('systemGeneral.tabs.networkProxy') }]
          : []),
      ] as { key: string; label: string }[],
    [canRead, proxy.canRead, t],
  );

  const goToTab = useCallback(
    (key: string) => {
      const next = new URLSearchParams(params);
      next.set('tab', key);
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  if (!canRead && !proxy.canRead) {
    return (
      <Flexbox padding={24}>
        <Text type="secondary">{t('page.forbidden.desc')}</Text>
      </Flexbox>
    );
  }

  return (
    <AdminPageTemplate
      description={t('systemGeneral.description')}
      title={t('systemGeneral.title')}
      toolbar={
        tabs.length > 1 ? (
          <Tabs activeKey={tab} items={tabs} onChange={(key) => goToTab(key)} />
        ) : undefined
      }
    >
      {tab === 'infrastructure' ? (
        <SystemGeneralPageView
          canOperate={canOperate}
          data={settings.data}
          error={settings.error}
          isLoading={settings.isLoading}
          probeBusy={probe.busy}
          probeResults={probe.results}
          profileData={browserProfile.data}
          profileError={browserProfile.error}
          profileIsLoading={browserProfile.isLoading}
          profileOptions={browserProfileOptions.data}
          onProfileRegenerate={regenerateBrowserProfile}
          onProfileRetry={() => void browserProfile.mutate()}
          onProfileSave={saveBrowserProfile}
          onRetry={() => void settings.mutate()}
          onTest={(dependency) => void probe.run(dependency)}
        />
      ) : null}
      {tab === 'network-proxy' ? (
        <NetworkProxyTab canManage={proxy.canManage} enabled={allowed && proxy.canRead} />
      ) : null}
    </AdminPageTemplate>
  );
});

SystemGeneralPage.displayName = 'AdminSystemGeneralPage';

export default SystemGeneralPage;
