'use client';

import { Alert, Flexbox } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

interface SharedOAuthStatusRetryProps {
  onRetry: () => void;
}

/** The connection status itself could not be read — nothing about the account is knowable. */
const SharedOAuthStatusRetry = memo<SharedOAuthStatusRetryProps>(({ onRetry }) => {
  const { t } = useTranslation('admin');

  return (
    <Flexbox gap={12}>
      <Alert message={t('aiProviderSettings.sharedOAuth.statusFailed')} type={'warning'} />
      <Flexbox horizontal>
        <Button onClick={onRetry}>{t('aiProviderSettings.sharedOAuth.retryStatus')}</Button>
      </Flexbox>
    </Flexbox>
  );
});

SharedOAuthStatusRetry.displayName = 'AdminSharedOAuthStatusRetry';

export default SharedOAuthStatusRetry;
