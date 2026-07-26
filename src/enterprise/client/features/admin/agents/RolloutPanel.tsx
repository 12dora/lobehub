import { Alert, Block, Flexbox, Tag, Text } from '@lobehub/ui';
import { Button, toast } from '@lobehub/ui/base-ui';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  type AdminReauthAuthMethod,
  isAdminReauthRequiredError,
} from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { openReasonModal } from '@/enterprise/client/features/admin/users/modals/openReasonModal';
import { adminAgentsService } from '@/enterprise/client/services/adminAgents';

import type { deriveAdminAgentPermissions } from './controller';
import type { AdminAgentDetailOutput } from './types';
import type { RefreshLock, WriteToken } from './useRefreshLock';

interface RolloutPanelProps {
  authMethod: AdminReauthAuthMethod | null;
  /** Whether the adapter exposes a real Rollout backend (PR-052). Off ⇒ full-surface defer gate. */
  enabled: boolean;
  loadingMore?: boolean;
  loadMoreError?: boolean;
  /**
   * Shared detail refresh gate. Identity-changing rollback must run through begin/commit so a
   * failed post-commit refresh locks publish/assignment writes on the stale snapshot.
   */
  lock: RefreshLock;
  /** True when the detail aggregate hit the page ceiling for rollouts (more rows exist server-side). */
  onLoadMoreRollouts?: () => Promise<void>;
  permissions: ReturnType<typeof deriveAdminAgentPermissions>;
  pollError?: unknown;
  refresh: () => Promise<AdminAgentDetailOutput | undefined>;
  retryPoll?: () => Promise<unknown>;
  rolloutsTruncated?: boolean;
  snapshot: AdminAgentDetailOutput;
}

export const RolloutPanel = ({
  authMethod,
  enabled,
  lock,
  loadMoreError = false,
  loadingMore = false,
  onLoadMoreRollouts,
  permissions,
  pollError,
  refresh,
  retryPoll,
  rolloutsTruncated = false,
  snapshot,
}: RolloutPanelProps) => {
  const { t } = useTranslation('admin');
  const busyJobRef = useRef<string | null>(null);
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  // Local refresh failure for cancel/retry (job-only CAS). Rollback uses the shared lock instead.
  const [localRefreshFailed, setLocalRefreshFailed] = useState(false);
  const retryLocalRefresh = async () => {
    setLocalRefreshFailed(false);
    try {
      const refreshed = await refresh();
      if (!refreshed) setLocalRefreshFailed(true);
    } catch {
      setLocalRefreshFailed(true);
    }
  };
  const mutateRollout = (
    rollout: AdminAgentDetailOutput['rollouts'][number],
    action: 'cancel' | 'retry' | 'rollback',
  ) => {
    // Gate concurrency before opening the modal — same pattern as useAgentActions. Do NOT check
    // isLocked() inside onSubmit when a writeToken exists: reauth retry re-enters with the lock
    // still held so beginWrite can apply its same-token re-entry rule.
    if (lock.isLocked()) return;
    // One token for this logical write — shared reauth retry re-enters with the same token.
    const writeToken: WriteToken | null = action === 'rollback' ? {} : null;
    openReasonModal({
      authMethod: authMethod ?? undefined,
      danger: action === 'cancel' || action === 'rollback',
      description: t(`agentCatalog.rollout.${action}Description` as never),
      buildPayload: (reason) => {
        if (action === 'rollback') {
          return {
            agentId: snapshot.identity.id,
            expectedJobRevision: rollout.revision,
            expectedStatus: 'completed' as const,
            jobId: rollout.jobId,
            reason,
            targetVersionId: rollout.previousVersionId!,
          };
        }
        if (action === 'cancel') {
          return {
            agentId: snapshot.identity.id,
            expectedJobRevision: rollout.revision,
            expectedStatus: rollout.status as 'pending' | 'running',
            jobId: rollout.jobId,
            reason,
          };
        }
        return {
          agentId: snapshot.identity.id,
          expectedJobRevision: rollout.revision,
          expectedStatus: rollout.status as 'cancelled' | 'dead' | 'failed',
          jobId: rollout.jobId,
          reason,
        };
      },
      onPhaseChange: (phase) => {
        // Reauth cancel / terminal idle → unlock rollback if the write never committed.
        if (phase === 'idle' && writeToken) lock.abortWrite(writeToken);
      },
      onSubmit: async (input) => {
        // busyJobRef resets in finally so it never blocks the reauth retry.
        // isLocked is only consulted here when there is no write token (cancel/retry).
        if (busyJobRef.current || (!writeToken && lock.isLocked())) {
          throw new Error(t('agentCatalog.recovery.refreshFailed'));
        }
        busyJobRef.current = rollout.jobId;
        setBusyJobId(rollout.jobId);
        setLocalRefreshFailed(false);

        if (writeToken && !lock.beginWrite(writeToken)) {
          busyJobRef.current = null;
          setBusyJobId(null);
          throw new Error(t('agentCatalog.recovery.refreshFailed'));
        }

        try {
          if (action === 'cancel') {
            await adminAgentsService.cancelRollout(
              input as Parameters<typeof adminAgentsService.cancelRollout>[0],
            );
          } else if (action === 'retry') {
            await adminAgentsService.retryRollout(
              input as Parameters<typeof adminAgentsService.retryRollout>[0],
            );
          } else {
            if (!rollout.previousVersionId) return;
            const result = await adminAgentsService.rollbackRollout(
              input as Parameters<typeof adminAgentsService.rollbackRollout>[0],
            );
            if (result.invalidationStatus === 'deferred') {
              toast.warning(t('agentCatalog.toast.refreshDeferred'));
            }
            // Identity CAS advanced server-side — commit through the shared freshness lock.
            if (writeToken) {
              lock.markCommitted(writeToken);
              await lock.commitWrite(writeToken);
              if (lock.isLocked()) return; // refreshFailed banner lives on the shared lock surface
            }
            if (result.invalidationStatus !== 'deferred') {
              toast.success(t(`agentCatalog.rollout.${action}Requested` as never));
            }
            return;
          }

          let refreshed = false;
          try {
            refreshed = Boolean(await refresh());
          } catch {
            // The mutation has committed; keep the loaded projection visible and offer an explicit retry.
          }
          if (!refreshed) {
            setLocalRefreshFailed(true);
            return;
          }
          toast.success(t(`agentCatalog.rollout.${action}Requested` as never));
        } catch (cause) {
          if (isAdminReauthRequiredError(cause)) throw cause; // retryable: keep frozen CAS payload
          if (writeToken) lock.abortWrite(writeToken);
          throw cause;
        } finally {
          busyJobRef.current = null;
          setBusyJobId(null);
        }
      },
      submitLabel: t(`agentCatalog.rollout.${action}` as never),
      targetLabel: snapshot.identity.agentKey,
      title: t(`agentCatalog.rollout.${action}` as never),
    });
  };

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

  const writesLocked = lock.locked || busyJobId !== null;

  return (
    <Flexbox gap={12}>
      <Text as="h3" fontSize={16} weight={600}>
        {t('agentCatalog.rollout.title')}
      </Text>
      {rolloutsTruncated ? (
        <Alert
          showIcon
          description={t('agentCatalog.collection.truncatedRollouts')}
          message={t('agentCatalog.collection.truncated')}
          type="warning"
          action={
            onLoadMoreRollouts ? (
              <Button loading={loadingMore} size="small" onClick={() => void onLoadMoreRollouts()}>
                {t(
                  loadMoreError
                    ? 'agentCatalog.collection.retry'
                    : 'agentCatalog.collection.loadMore',
                )}
              </Button>
            ) : undefined
          }
        />
      ) : null}
      {pollError ? (
        <Alert
          showIcon
          message={t('agentCatalog.rollout.pollFailed')}
          type="warning"
          action={
            <Button size="small" onClick={() => void retryPoll?.()}>
              {t('agentCatalog.rollout.pollRetry')}
            </Button>
          }
        />
      ) : null}
      {localRefreshFailed ? (
        <Alert
          showIcon
          message={t('agentCatalog.rollout.refreshFailed')}
          type="warning"
          action={
            <Button size="small" onClick={() => void retryLocalRefresh()}>
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
                  disabled={writesLocked}
                  onClick={() => mutateRollout(rollout, 'cancel')}
                >
                  {t('agentCatalog.rollout.cancel')}
                </Button>
              ) : null}
              {permissions.canAssign && ['cancelled', 'dead', 'failed'].includes(rollout.status) ? (
                <Button disabled={writesLocked} onClick={() => mutateRollout(rollout, 'retry')}>
                  {t('agentCatalog.rollout.retry')}
                </Button>
              ) : null}
              {permissions.canPublish &&
              rollout.status === 'completed' &&
              rollout.previousVersionId ? (
                <Button
                  danger
                  disabled={writesLocked}
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
