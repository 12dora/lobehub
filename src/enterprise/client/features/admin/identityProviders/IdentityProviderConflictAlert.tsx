'use client';

import { Alert, Flexbox } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

interface IdentityProviderConflictAlertProps {
  onDiscard: () => void;
  onRefresh: () => Promise<void>;
  refreshFailed: boolean;
}

export const IdentityProviderConflictAlert = memo<IdentityProviderConflictAlertProps>(
  ({ onDiscard, onRefresh, refreshFailed }) => {
    const { t } = useTranslation('admin');

    return (
      <Alert
        showIcon
        type="warning"
        action={
          <Flexbox horizontal gap={6}>
            <Button size="small" onClick={() => void onRefresh()}>
              {t('identityProviders.conflict.refresh')}
            </Button>
            <Button size="small" onClick={onDiscard}>
              {t('identityProviders.conflict.discard')}
            </Button>
          </Flexbox>
        }
        description={t(
          refreshFailed
            ? 'identityProviders.conflict.refreshFailed'
            : 'identityProviders.conflict.rebased',
        )}
      />
    );
  },
);

IdentityProviderConflictAlert.displayName = 'IdentityProviderConflictAlert';
