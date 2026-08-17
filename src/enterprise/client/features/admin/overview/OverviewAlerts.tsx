'use client';

import { Alert } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { useTranslation } from 'react-i18next';

interface OverviewAlertProps {
  onRetry: () => void;
}

export const OverviewLoadErrorAlert = ({ onRetry }: OverviewAlertProps) => {
  const { t } = useTranslation('admin');

  return (
    <Alert
      showIcon
      description={t('overview.error.loadFailedDescription')}
      message={t('overview.error.loadFailed')}
      type="error"
      action={
        <Button size="small" onClick={onRetry}>
          {t('overview.error.retry')}
        </Button>
      }
    />
  );
};

export const OverviewRefreshWarningAlert = ({ onRetry }: OverviewAlertProps) => {
  const { t } = useTranslation('admin');

  return (
    <Alert
      showIcon
      description={t('overview.error.refreshFailedDescription')}
      message={t('overview.error.refreshFailed')}
      type="warning"
      action={
        <Button size="small" onClick={onRetry}>
          {t('overview.error.retry')}
        </Button>
      }
    />
  );
};
