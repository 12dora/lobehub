'use client';

import { Alert, Flexbox, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import StatusBadge from '../primitives/StatusBadge';
import { identityProviderStyles as styles } from './styles';

interface EasyauthStatus {
  config: {
    appKey: string;
    baseUrl: string;
    portalUrl: string | null;
    tokenConfigured: boolean;
  };
  sync: {
    accessGrantedCount: number;
    degradedCount: number;
    latestFetchedAt: Date | string | null;
    totalCount: number;
  };
}

interface EasyauthStatusCardProps {
  data?: EasyauthStatus;
  error?: boolean;
  loading?: boolean;
  onRetry?: () => void;
}

const EasyauthStatusCard = memo<EasyauthStatusCardProps>(({ data, error, loading, onRetry }) => {
  const { t } = useTranslation('admin');

  return (
    <div className={styles.card} data-testid="easyauth-status-card">
      <Flexbox horizontal align="center" gap={8} justify="space-between">
        <Text strong>{t('identityProviders.easyauth.title')}</Text>
        {data ? <StatusBadge status={data.config.tokenConfigured ? 'active' : 'disabled'} /> : null}
      </Flexbox>
      <Text type="secondary">{t('identityProviders.easyauth.description')}</Text>

      {loading && !data ? (
        <Text role="status" type="secondary">
          {t('identityProviders.easyauth.loading')}
        </Text>
      ) : null}

      {error && !data ? (
        <Alert
          showIcon
          description={t('identityProviders.easyauth.loadError')}
          type="warning"
          action={
            onRetry ? (
              <Button size="small" onClick={onRetry}>
                {t('identityProviders.actions.retry')}
              </Button>
            ) : undefined
          }
        />
      ) : null}

      {data ? (
        <Flexbox gap={8}>
          {!data.config.tokenConfigured ? (
            <Alert showIcon description={t('identityProviders.easyauth.tokenHint')} type="info" />
          ) : null}
          {data.sync.degradedCount > 0 ? (
            <Alert
              showIcon
              type="warning"
              description={t('identityProviders.easyauth.degradedWarning', {
                count: data.sync.degradedCount,
              })}
            />
          ) : null}
        </Flexbox>
      ) : null}
    </div>
  );
});

EasyauthStatusCard.displayName = 'EasyauthStatusCard';
export default EasyauthStatusCard;
