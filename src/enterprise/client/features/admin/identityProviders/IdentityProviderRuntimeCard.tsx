'use client';

import { Alert, Flexbox, Tag, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import StatusBadge from '../primitives/StatusBadge';
import { identityProviderStyles as styles } from './styles';

interface RuntimeStatus {
  active: { allFreshInstancesActive: boolean; partial: boolean };
  artifact: {
    degradedCategory?: string | null;
    health: string;
    source: string;
  };
  instances: Array<{
    activeIdentityRevision: string | null;
    fresh: boolean;
    instanceId: string;
    startupSource: string;
  }>;
  pendingPublished: Array<{
    blockedCategory?: string | null;
    providerId: string;
    providerKey: string;
  }>;
  pendingRestart: boolean;
  restart: { reason?: string | null; supported: boolean };
  targetIdentityRevision: string | null;
}

interface IdentityProviderRuntimeCardProps {
  loadError?: boolean;
  onRetry?: () => void;
  restartError?: string | null;
  status: RuntimeStatus | undefined;
}

const IdentityProviderRuntimeCard = memo<IdentityProviderRuntimeCardProps>(
  ({ loadError, onRetry, restartError, status }) => {
    const { t } = useTranslation('admin');

    if (loadError) {
      return (
        <div className={styles.card} data-testid="identity-runtime-status">
          <Text strong>{t('identityProviders.runtime.title')}</Text>
          <Alert
            showIcon
            description={t('identityProviders.runtime.loadError')}
            type="warning"
            action={
              onRetry ? (
                <Button size="small" onClick={onRetry}>
                  {t('identityProviders.actions.retry')}
                </Button>
              ) : undefined
            }
          />
        </div>
      );
    }

    if (!status) return null;

    const healthy = status.artifact.health === 'healthy';

    return (
      <div className={styles.card} data-testid="identity-runtime-status">
        <Flexbox horizontal align="center" gap={8} justify="space-between">
          <Text strong>{t('identityProviders.runtime.title')}</Text>
          <StatusBadge status={healthy ? 'active' : 'error'} />
        </Flexbox>
        {restartError ? <Alert showIcon description={restartError} type="error" /> : null}
        <Text type="secondary">
          {t('identityProviders.runtime.healthSummary', {
            health: t(`identityProviders.values.health.${status.artifact.health}` as never),
          })}
        </Text>
        <Text type="secondary">
          {t('identityProviders.runtime.source', {
            source: t(`identityProviders.values.source.${status.artifact.source}` as never),
          })}
        </Text>
        <Text className={styles.revision}>
          {t('identityProviders.runtime.targetRevision', {
            revision: status.targetIdentityRevision ?? '—',
          })}
        </Text>
        <Text>
          {t('identityProviders.runtime.pending', {
            count: status.pendingPublished.length,
          })}
        </Text>
        {status.pendingPublished
          .filter((provider) => provider.blockedCategory)
          .map((provider) => (
            <Alert
              showIcon
              key={provider.providerId}
              type="warning"
              description={t('identityProviders.runtime.environmentShadowed', {
                categoryLabel: t(
                  `identityProviders.values.degraded.${provider.blockedCategory}` as never,
                ),
                provider: provider.providerKey,
              })}
            />
          ))}
        {status.active.partial ? (
          <Alert showIcon description={t('identityProviders.runtime.partial')} type="warning" />
        ) : null}
        {status.artifact.health === 'degraded' ? (
          <Alert
            showIcon
            type="warning"
            description={t('identityProviders.runtime.degraded', {
              category: t(
                `identityProviders.values.degraded.${status.artifact.degradedCategory ?? 'unknown'}` as never,
              ),
            })}
          />
        ) : null}
        {!status.restart.supported && status.pendingRestart ? (
          <Alert
            showIcon
            type="info"
            description={t('identityProviders.restart.unsupported', {
              reason: t(
                `identityProviders.values.restartReason.${status.restart.reason ?? 'unknown'}` as never,
              ),
            })}
          />
        ) : null}
        {status.instances.length === 0 ? (
          <Text type="secondary">{t('identityProviders.runtime.noInstances')}</Text>
        ) : (
          status.instances.map((instance) => (
            <div className={styles.instance} key={instance.instanceId}>
              <Flexbox gap={2}>
                <Text>{instance.instanceId.slice(0, 16)}…</Text>
                <Text className={styles.revision} type="secondary">
                  {t('identityProviders.runtime.instanceRevision', {
                    revision: instance.activeIdentityRevision ?? '—',
                  })}
                </Text>
              </Flexbox>
              <Flexbox horizontal gap={6}>
                <Tag>{t(`identityProviders.values.source.${instance.startupSource}` as never)}</Tag>
                <Tag color={instance.fresh ? 'green' : 'default'}>
                  {instance.fresh
                    ? t('identityProviders.runtime.fresh')
                    : t('identityProviders.runtime.stale')}
                </Tag>
              </Flexbox>
            </div>
          ))
        )}
      </div>
    );
  },
);

IdentityProviderRuntimeCard.displayName = 'IdentityProviderRuntimeCard';
export default IdentityProviderRuntimeCard;
