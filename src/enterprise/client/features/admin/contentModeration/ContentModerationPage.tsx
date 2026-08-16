'use client';

import { Flexbox, Text } from '@lobehub/ui';
import { Tabs } from '@lobehub/ui/base-ui';
import { memo, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import OverviewTab from './overview/OverviewTab';
import { deriveModerationPermissions } from './permissions';
import RecordsTab from './records/RecordsTab';
import SettingsTab from './settings/SettingsTab';

export const MODERATION_TABS = ['overview', 'records', 'settings'] as const;
export type ModerationTab = (typeof MODERATION_TABS)[number];

const isModerationTab = (value: string | null): value is ModerationTab =>
  value !== null && (MODERATION_TABS as readonly string[]).includes(value);

/**
 * 审计 → 内容审计 (design §6): 概况 / 违规记录 / 设置.
 *
 * All three tabs need MODERATION_READ; write controls inside them are gated on
 * MODERATION_MANAGE (disabled + tooltip, never hidden — an auditor should still see
 * that the control exists). The active tab rides in `?tab=` so the overview charts can
 * deep-link into a filtered record list.
 */
const ContentModerationPage = memo(() => {
  const { t } = useTranslation('admin');
  const { permissions, status } = useAdminAccess();
  const [params, setParams] = useSearchParams();

  const { canBanUsers, canManage, canRead } = deriveModerationPermissions(permissions);
  const enabled = status === 'allowed' && canRead;

  const tabs = useMemo(
    () => [
      { key: 'overview' as const, label: t('contentModeration.tabs.overview') },
      { key: 'records' as const, label: t('contentModeration.tabs.records') },
      { key: 'settings' as const, label: t('contentModeration.tabs.settings') },
    ],
    [t],
  );

  const raw = params.get('tab');
  const tab: ModerationTab = isModerationTab(raw) ? raw : 'overview';

  const goToTab = useCallback(
    (key: string, extra?: Record<string, string | undefined>) => {
      const next = new URLSearchParams(params);
      next.set('tab', key);
      for (const [name, value] of Object.entries(extra ?? {})) {
        if (value === undefined) next.delete(name);
        else next.set(name, value);
      }
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  if (!canRead) {
    return (
      <Flexbox padding={24}>
        <Text type="secondary">{t('page.forbidden.desc')}</Text>
      </Flexbox>
    );
  }

  return (
    <AdminPageTemplate
      description={t('contentModeration.page.desc')}
      title={t('contentModeration.page.title')}
      toolbar={
        <Tabs
          activeKey={tab}
          items={tabs}
          onChange={(key) => {
            goToTab(key);
          }}
        />
      }
    >
      {tab === 'overview' ? (
        <OverviewTab
          canManage={canManage}
          enabled={enabled}
          onOpenRecordsForUser={(userId) => goToTab('records', { recordId: undefined, userId })}
          onOpenSettings={() => goToTab('settings')}
        />
      ) : null}
      {tab === 'records' ? (
        <RecordsTab canBanUsers={canBanUsers} canManage={canManage} enabled={enabled} />
      ) : null}
      {tab === 'settings' ? <SettingsTab canManage={canManage} enabled={enabled} /> : null}
    </AdminPageTemplate>
  );
});

ContentModerationPage.displayName = 'AdminContentModerationPage';

export default ContentModerationPage;
