import { Alert, NeuralNetworkLoading } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import type { TFunction } from 'i18next';

import type { IdentityProviderRestartPhase } from './controller';
import { identityProviderStyles as styles } from './styles';

interface IdentityProviderRestartBannerProps {
  onRetry: () => void;
  phase: IdentityProviderRestartPhase;
  resultCategory?: string | null;
  t: TFunction<'admin'>;
}

export const IdentityProviderRestartBanner = ({
  onRetry,
  phase,
  resultCategory,
  t,
}: IdentityProviderRestartBannerProps) =>
  phase === 'accepted' ? (
    <Alert
      showIcon
      description={t('identityProviders.restart.reconnecting')}
      type="info"
      action={
        <span
          aria-label={t('identityProviders.restart.monitoring')}
          className={styles.restartActivity}
          role="status"
        >
          <span className={styles.restartActivityAnimated}>
            <NeuralNetworkLoading size={16} />
          </span>
          <span aria-hidden className={styles.restartActivityStatic}>
            ●
          </span>
        </span>
      }
    />
  ) : phase === 'activated' ? (
    <Alert showIcon description={t('identityProviders.restart.activated')} type="success" />
  ) : phase === 'failed' ? (
    <Alert
      showIcon
      type="error"
      action={
        <Button size="small" onClick={onRetry}>
          {t('identityProviders.actions.retry')}
        </Button>
      }
      description={
        resultCategory
          ? t('identityProviders.restart.failedWithCategory', {
              category: resultCategory,
              defaultValue: `Restart failed (${resultCategory})`,
            })
          : t('identityProviders.restart.failed')
      }
    />
  ) : null;
