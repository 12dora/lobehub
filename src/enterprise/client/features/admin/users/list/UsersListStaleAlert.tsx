'use client';

import { Alert } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

/** Cached rows are still on screen — say so and offer the retry that replaces them. */
export const UsersListStaleAlert = memo<{ onRetry: () => void }>(({ onRetry }) => {
  const { t } = useTranslation('admin');

  return (
    <Alert
      showIcon
      style={{ marginBottom: 12 }}
      type="warning"
      action={
        <Button size="small" onClick={onRetry}>
          {t('primitives.dataTable.retry')}
        </Button>
      }
      message={t('users.stale.refreshFailed', {
        defaultValue: 'Showing cached data — the latest refresh failed.',
      })}
    />
  );
});

UsersListStaleAlert.displayName = 'AdminUsersListStaleAlert';
