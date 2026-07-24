'use client';

import { Flexbox, Text } from '@lobehub/ui';
import { Tabs } from '@lobehub/ui/base-ui';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';

import ManagedResourcesPolicyPage from '../managedResources/ManagedResourcesPolicyPage';
import SettingsPolicyPage from '../settings/SettingsPolicyPage';

type UnifiedTab = 'managed' | 'settings';

/**
 * "统一管理 / Unified management" — merges the former Settings-policy and
 * Managed-resources tabs into one nav surface. Each sub-tab is the full page
 * (rendered `embedded`, so it drops its own <h1> since the tab already names it);
 * only one mounts at a time, so their sticky footers never collide. The active
 * tab rides in `?tab=` for deep links (e.g. from DirtyDraftAlert).
 *
 * The nav entry is shell-gated (no single permission covers both), so tabs are
 * gated here: only the sub-surfaces the admin can read are shown, and the active
 * tab falls back to the first readable one — never a blank surface.
 */
const UnifiedManagementPage = memo(() => {
  const { t } = useTranslation('admin');
  const { permissions } = useAdminAccess();
  const [params, setParams] = useSearchParams();

  const granted = useMemo(() => new Set(permissions), [permissions]);
  const canReadSettings = granted.has(PLATFORM_PERMISSIONS.SETTINGS_READ);
  // Policy map OR connector governance (nested shared-OAuth control is independently authorized).
  const canReadManaged =
    granted.has(PLATFORM_PERMISSIONS.POLICY_READ) ||
    granted.has(PLATFORM_PERMISSIONS.CONNECTOR_READ);

  const tabs = useMemo(() => {
    const items: { key: UnifiedTab; label: string }[] = [];
    if (canReadSettings) items.push({ key: 'settings', label: t('settingsPolicy.title') });
    if (canReadManaged) items.push({ key: 'managed', label: t('managedResources.title') });
    return items;
  }, [canReadManaged, canReadSettings, t]);

  if (tabs.length === 0) {
    return (
      <Flexbox padding={24}>
        <Text type="secondary">{t('page.forbidden.desc')}</Text>
      </Flexbox>
    );
  }

  const requested: UnifiedTab = params.get('tab') === 'managed' ? 'managed' : 'settings';
  const tab: UnifiedTab = tabs.some((item) => item.key === requested) ? requested : tabs[0].key;

  return (
    <Flexbox gap={12} height={'100%'}>
      <Tabs
        activeKey={tab}
        items={tabs}
        onChange={(key) => {
          const next = new URLSearchParams(params);
          next.set('tab', key);
          setParams(next, { replace: true });
        }}
      />
      {tab === 'settings' ? (
        <SettingsPolicyPage embedded />
      ) : (
        <ManagedResourcesPolicyPage embedded />
      )}
    </Flexbox>
  );
});

UnifiedManagementPage.displayName = 'UnifiedManagementPage';

export default UnifiedManagementPage;
