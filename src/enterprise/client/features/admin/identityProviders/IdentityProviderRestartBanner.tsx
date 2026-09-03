import { Alert, Flexbox, NeuralNetworkLoading } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import type { TFunction } from 'i18next';

import type { IdentityProviderRestartPhase } from './controller';
import { identityProviderStyles as styles } from './styles';

interface IdentityProviderRestartBannerProps {
  onRetry: () => void;
  phase: IdentityProviderRestartPhase;
  resultCategory?: string | null;
  /** Last start fell back to break-glass / LKG, so another restart alone cannot activate. */
  startupLoadFailed?: boolean;
  t: TFunction<'admin'>;
}

const RestartPhaseAlert = ({
  onRetry,
  phase,
  resultCategory,
  t,
}: Omit<IdentityProviderRestartBannerProps, 'startupLoadFailed'>) =>
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

export const IdentityProviderRestartBanner = ({
  startupLoadFailed,
  t,
  ...phaseProps
}: IdentityProviderRestartBannerProps) => {
  const phaseAlert = <RestartPhaseAlert {...phaseProps} t={t} />;
  if (!startupLoadFailed) return phaseAlert;
  return (
    <Flexbox gap={8}>
      {phaseAlert}
      <Alert
        showIcon
        description={t('identityProviders.restart.startupLoadFailed')}
        type="warning"
      />
    </Flexbox>
  );
};
