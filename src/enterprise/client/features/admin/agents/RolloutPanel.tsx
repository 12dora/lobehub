import { Alert, Block, Flexbox, Tag, Text } from '@lobehub/ui';
import { Button, toast } from '@lobehub/ui/base-ui';
import { useTranslation } from 'react-i18next';

import { adminAgentsService } from '@/enterprise/client/services/adminAgents';

import type { deriveAdminAgentPermissions } from './controller';
import { openAgentReasonModal } from './openAgentReasonModal';
import type { AdminAgentDetailOutput } from './types';

interface RolloutPanelProps {
  /** Whether the adapter exposes a real Rollout backend (PR-052). Off ⇒ full-surface defer gate. */
  enabled: boolean;
  permissions: ReturnType<typeof deriveAdminAgentPermissions>;
  refresh: () => Promise<AdminAgentDetailOutput | undefined>;
  snapshot: AdminAgentDetailOutput;
}

export const RolloutPanel = ({ enabled, permissions, refresh, snapshot }: RolloutPanelProps) => {
  const { t } = useTranslation('admin');
  const mutateRollout = (
    rollout: AdminAgentDetailOutput['rollouts'][number],
    action: 'cancel' | 'retry',
  ) =>
    openAgentReasonModal({
      danger: action === 'cancel',
      description: t(`agentCatalog.rollout.${action}Description` as never),
      onConfirm: async (reason) => {
        const input = {
          agentId: snapshot.identity.id,
          expectedJobRevision: rollout.revision,
          expectedStatus: rollout.status,
          jobId: rollout.jobId,
          reason,
        };
        if (action === 'cancel') await adminAgentsService.cancelRollout(input);
        else await adminAgentsService.retryRollout(input);
        await refresh();
        toast.success(t(`agentCatalog.rollout.${action}Requested` as never));
      },
      submitLabel: t(`agentCatalog.rollout.${action}` as never),
      title: t(`agentCatalog.rollout.${action}` as never),
    });

  if (!enabled)
    return (
      <Flexbox gap={12}>
        <Text as="h3" fontSize={16} weight={600}>
          {t('agentCatalog.rollout.title')}
        </Text>
        <Alert
          showIcon
          description={t('agentCatalog.rollout.deferred')}
          message={t('agentCatalog.rollout.deferredTitle')}
          type="info"
        />
      </Flexbox>
    );

  return (
    <Flexbox gap={12}>
      <Text as="h3" fontSize={16} weight={600}>
        {t('agentCatalog.rollout.title')}
      </Text>
      {snapshot.rollouts.length === 0 ? (
        <Text type="secondary">{t('agentCatalog.rollout.empty')}</Text>
      ) : (
        snapshot.rollouts.map((rollout) => (
          <Block key={rollout.jobId} padding={16} variant="outlined">
            <Flexbox horizontal align="center" gap={12} justify="space-between" wrap="wrap">
              <Flexbox gap={4}>
                <Flexbox horizontal gap={8}>
                  <Tag
                    color={
                      rollout.status === 'dead' || rollout.status === 'failed' ? 'error' : undefined
                    }
                  >
                    {t(`agentCatalog.rollout.status.${rollout.status}` as never)}
                  </Tag>
                  <Text code>{rollout.jobId}</Text>
                </Flexbox>
                <Text type="secondary">
                  {t('agentCatalog.rollout.progress', {
                    completed: rollout.completed,
                    failed: rollout.failed,
                    total: rollout.total,
                  })}
                </Text>
              </Flexbox>
              {permissions.canAssign && ['pending', 'running'].includes(rollout.status) ? (
                <Button danger onClick={() => mutateRollout(rollout, 'cancel')}>
                  {t('agentCatalog.rollout.cancel')}
                </Button>
              ) : null}
              {permissions.canAssign && ['cancelled', 'dead', 'failed'].includes(rollout.status) ? (
                <Button onClick={() => mutateRollout(rollout, 'retry')}>
                  {t('agentCatalog.rollout.retry')}
                </Button>
              ) : null}
            </Flexbox>
          </Block>
        ))
      )}
      {snapshot.rollouts.some(({ status }) => status === 'dead') ? (
        <Alert message={t('agentCatalog.rollout.deadHelp')} type="error" />
      ) : null}
    </Flexbox>
  );
};
