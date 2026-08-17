'use client';

import { Tabs } from '@lobehub/ui/base-ui';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import { useModuleEnabled } from '@/enterprise/client/hooks/useModuleEnabled';

import GeneralSettingsPage from '../generalSettings/GeneralSettingsPage';
import IdentityProviderPage from '../identityProviders/IdentityProviderPage';
import AdminPageTemplate from '../primitives/AdminPageTemplate';

type SecurityAuthTab = 'general' | 'login';

/**
 * "安全与认证 / Security & Authentication" — a merged nav surface with two tabs:
 * "登录方式" (the identity-provider page) and "通用设置" (registration/login policy).
 * Each sub-page renders `embedded`, so it drops its own <h1> (the tab already names it).
 * The active tab rides in `?tab=` for deep links, mirroring UnifiedManagementPage.
 */
const SecurityAuthPage = memo(() => {
  const { t } = useTranslation('admin');
  const [params, setParams] = useSearchParams();

  // 登录方式 is the database-IdP module; 通用设置 (registration/login policy) is core, so the
  // surface stays reachable with the module off — only the tab it owns goes away.
  const loginTabEnabled = useModuleEnabled('databaseIdp');

  const tabs = useMemo(
    () => [
      ...(loginTabEnabled ? [{ key: 'login' as const, label: t('securityAuth.tabs.login') }] : []),
      { key: 'general' as const, label: t('securityAuth.tabs.general') },
    ],
    [loginTabEnabled, t],
  );

  // Never strand an admin on a tab that is no longer offered.
  const tab: SecurityAuthTab =
    !loginTabEnabled || params.get('tab') === 'general' ? 'general' : 'login';

  return (
    <AdminPageTemplate
      fullHeight
      description={t('page.securityAuth.desc')}
      title={t('nav.securityAuth')}
      toolbar={
        <Tabs
          activeKey={tab}
          items={tabs}
          onChange={(key) => {
            const next = new URLSearchParams(params);
            next.set('tab', key);
            setParams(next, { replace: true });
          }}
        />
      }
    >
      {tab === 'general' ? <GeneralSettingsPage embedded /> : <IdentityProviderPage embedded />}
    </AdminPageTemplate>
  );
});

SecurityAuthPage.displayName = 'SecurityAuthPage';

export default SecurityAuthPage;
