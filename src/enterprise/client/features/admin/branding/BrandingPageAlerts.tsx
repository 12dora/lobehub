'use client';

import { Alert } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

const styles = createStaticStyles(({ css }) => ({
  stack: css`
    display: flex;
    flex-direction: column;
    gap: 16px;
  `,
}));

export interface BrandingPageAlertsProps {
  actionError: string | null;
  actionNotice: string | null;
  canSave: boolean;
  conflict: boolean;
  refreshWarning: string | null;
  reload: () => Promise<void>;
  reloadFailed: boolean;
  retryingRefresh: boolean;
  retryRefresh: () => Promise<void>;
  storageConfigured: boolean;
}

export const BrandingPageAlerts = memo<BrandingPageAlertsProps>(
  ({
    actionError,
    actionNotice,
    canSave,
    conflict,
    refreshWarning,
    reload,
    reloadFailed,
    retryRefresh,
    retryingRefresh,
    storageConfigured,
  }) => {
    const { t } = useTranslation('admin');
    const hasAlerts =
      conflict ||
      !storageConfigured ||
      !canSave ||
      Boolean(refreshWarning) ||
      Boolean(actionNotice) ||
      Boolean(actionError);
    if (!hasAlerts) return null;

    return (
      <div className={styles.stack}>
        {conflict ? (
          <Alert
            extraIsolate
            showIcon
            extra={<Button onClick={() => void reload()}>{t('branding.conflict.reload')}</Button>}
            message={t('branding.conflict.title')}
            type="warning"
            description={
              reloadFailed
                ? t('branding.conflict.reloadFailed')
                : t('branding.conflict.description')
            }
          />
        ) : null}
        {!storageConfigured ? (
          <Alert showIcon message={t('branding.storageUnavailable')} type="warning" />
        ) : null}
        {!canSave ? <Alert showIcon message={t('branding.readOnly')} type="info" /> : null}
        {refreshWarning ? (
          <Alert
            extraIsolate
            showIcon
            message={refreshWarning}
            type="warning"
            extra={
              <Button loading={retryingRefresh} onClick={() => void retryRefresh()}>
                {t('branding.refresh.retry')}
              </Button>
            }
          />
        ) : null}
        {actionNotice ? <Alert showIcon message={actionNotice} type="success" /> : null}
        {actionError ? <Alert showIcon message={actionError} type="error" /> : null}
      </div>
    );
  },
);

BrandingPageAlerts.displayName = 'BrandingPageAlerts';
