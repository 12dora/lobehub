import { Alert, Block, Flexbox, Tag, Text } from '@lobehub/ui';
import { Button, toast } from '@lobehub/ui/base-ui';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { adminAgentsService } from '@/enterprise/client/services/adminAgents';

import type { deriveAdminAgentPermissions } from './controller';
import { openAgentReasonModal } from './openAgentReasonModal';
import type { AdminAgentDetailOutput } from './types';

interface RolloutPanelProps {
  /** Whether the adapter exposes a real Rollout backend (PR-052). Off ⇒ full-surface defer gate. */
  enabled: boolean;
  permissions: ReturnType<typeof deriveAdminAgentPermissions>;
  pollError?: unknown;
  refresh: () => Promise<AdminAgentDetailOutput | undefined>;
  snapshot: AdminAgentDetailOutput;
}

export const RolloutPanel = ({
  enabled,
  permissions,
  pollError,
  refresh,
  snapshot,
}: RolloutPanelProps) => {
  const { t } = useTranslation('admin');
  const busyJobRef = useRef<string | null>(null);
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const retryRefresh = async () => {
    setRefreshFailed(false);
    try {
      const refreshed = await refresh();
      if (!refreshed) setRefreshFailed(true);
    } catch {
      setRefreshFailed(true);
    }
  };
  const mutateRollout = (
    rollout: AdminAgentDetailOutput['rollouts'][number],
    action: 'cancel' | 'retry' | 'rollback',
  ) =>
    openAgentReasonModal({
      danger: action === 'cancel',
      description: t(`agentCatalog.rollout.${action}Description` as never),
      onConfirm: async (reason) => {
        if (busyJobRef.current) return;
        busyJobRef.current = rollout.jobId;
        setBusyJobId(rollout.jobId);
        setRefreshFailed(false);
        const input = {
          agentId: snapshot.identity.id,
          expectedJobRevision: rollout.revision,
          expectedStatus: rollout.status,
          jobId: rollout.jobId,
          reason,
        };
        try {
          if (action === 'cancel') await adminAgentsService.cancelRollout(input);
          else if (action === 'retry') await adminAgentsService.retryRollout(input);
          else {
            if (!rollout.previousVersionId) return;
            await adminAgentsService.rollbackRollout({
              ...input,
              targetVersionId: rollout.previousVersionId,
            });
          }
          let refreshed = false;
          try {
            refreshed = Boolean(await refresh());
          } catch {
            // The mutation has committed; keep the loaded projection visible and offer an explicit retry.
          }
          if (!refreshed) {
            setRefreshFailed(true);
            return;
          }
          toast.success(t(`agentCatalog.rollout.${action}Requested` as never));
        } finally {
          busyJobRef.current = null;
          setBusyJobId(null);
        }
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
      {pollError ? (
        <Alert
          showIcon
          message={t('agentCatalog.rollout.pollFailed')}
          type="warning"
          action={
            <Button size="small" onClick={() => void retryRefresh()}>
              {t('agentCatalog.rollout.pollRetry')}
            </Button>
          }
        />
      ) : null}
      {refreshFailed ? (
        <Alert
          showIcon
          message={t('agentCatalog.rollout.refreshFailed')}
          type="warning"
          action={
            <Button size="small" onClick={() => void retryRefresh()}>
              {t('agentCatalog.rollout.refreshRetry')}
            </Button>
          }
        />
      ) : null}
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
                <Button
                  danger
                  disabled={busyJobId !== null}
                  onClick={() => mutateRollout(rollout, 'cancel')}
                >
                  {t('agentCatalog.rollout.cancel')}
                </Button>
              ) : null}
              {permissions.canAssign && ['cancelled', 'dead', 'failed'].includes(rollout.status) ? (
                <Button
                  disabled={busyJobId !== null}
                  onClick={() => mutateRollout(rollout, 'retry')}
                >
                  {t('agentCatalog.rollout.retry')}
                </Button>
              ) : null}
              {permissions.canPublish &&
              rollout.status === 'completed' &&
              rollout.previousVersionId ? (
                <Button
                  danger
                  disabled={busyJobId !== null}
                  onClick={() => mutateRollout(rollout, 'rollback')}
                >
                  {t('agentCatalog.rollout.rollback')}
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
