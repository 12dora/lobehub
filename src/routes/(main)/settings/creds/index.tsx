'use client';

import { Button, Icon, Tooltip } from '@lobehub/ui';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { usePermission } from '@/hooks/usePermission';
import SettingHeader from '@/routes/(main)/settings/features/SettingHeader';

import { createCreateCredModal } from './features/CreateCredModal';
import CredsList from './features/CredsList';
import { useCredsApi } from './features/useCredsApi';

export interface CredsSettingPageProps {
  /**
   * When false, hide the page SettingHeader title row (admin shell already
   * provides title). Create action still renders via `headerExtra` / default
   * create button path when header is hidden — see `createButton`.
   * Default true (market / workspace pages).
   */
  showSettingHeader?: boolean;
}

const Page = ({ showSettingHeader = true }: CredsSettingPageProps = {}) => {
  const { t } = useTranslation('setting');
  const { allowed: canManageCredentials, reason } = usePermission('manage_provider_key');
  const [refreshKey, setRefreshKey] = useState(0);
  const credsApi = useCredsApi();

  const handleCreate = () => {
    if (!canManageCredentials) return;
    createCreateCredModal({
      credsApi,
      onSuccess: () => setRefreshKey((k) => k + 1),
    });
  };

  const createButton = (
    <Tooltip title={reason}>
      <Button
        disabled={!canManageCredentials}
        icon={<Icon icon={Plus} />}
        size={'large'}
        onClick={handleCreate}
      >
        {t('creds.create')}
      </Button>
    </Tooltip>
  );

  return (
    <>
      {showSettingHeader ? (
        <SettingHeader extra={createButton} title={t('tab.creds')} />
      ) : (
        // Admin shell owns the page title; keep the create CTA visible.
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
          {createButton}
        </div>
      )}
      <CredsList key={refreshKey} />
    </>
  );
};

Page.displayName = 'CredsSetting';

export default Page;
