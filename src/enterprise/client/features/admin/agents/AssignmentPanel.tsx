'use client';

import { Alert, Block, Flexbox, Input, Tag, Text, Tooltip } from '@lobehub/ui';
import { Button, Select, Switch, toast } from '@lobehub/ui/base-ui';
import { useTranslation } from 'react-i18next';

import { runAdminMutation } from '@/enterprise/client/features/admin/primitives/runAdminMutation';
import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { adminAgentsService } from '@/enterprise/client/services/adminAgents';

import type { deriveAdminAgentPermissions } from './controller';
import type { AdminAgentDetailOutput } from './types';
import { useAssignmentEditor } from './useAssignmentEditor';
import type { RefreshLock } from './useRefreshLock';

interface AssignmentPanelProps {
  /** True when the detail aggregate hit the page ceiling for assignments. */
  assignmentsTruncated?: boolean;
  authMethod: AdminReauthAuthMethod | null;
  loadingMore?: boolean;
  loadMoreError?: boolean;
  /** Shared refresh gate; when a committed agent/assignment change awaits refresh, writes lock. */
  lock: RefreshLock;
  onLoadMoreAssignments?: () => Promise<void>;
  permissions: ReturnType<typeof deriveAdminAgentPermissions>;
  /**
   * Job-scoped detail refresh after Start. Start only enqueues a rollout and does NOT advance
   * agent identity CAS — never route it through the identity refresh lock's commitWrite path.
   */
  refresh: () => Promise<AdminAgentDetailOutput | undefined>;
  /** Whether the Rollout backend (PR-052) is available; off ⇒ Start rollout is gated/deferred. */
  rolloutsEnabled: boolean;
  snapshot: AdminAgentDetailOutput;
}

export const AssignmentPanel = ({
  assignmentsTruncated = false,
  authMethod,
  lock,
  loadMoreError = false,
  loadingMore = false,
  onLoadMoreAssignments,
  permissions,
  refresh,
  rolloutsEnabled,
  snapshot,
}: AssignmentPanelProps) => {
  const { t } = useTranslation('admin');
  const editor = useAssignmentEditor(snapshot, authMethod, lock);

  const startRollout = async (assignmentId: string) => {
    // Gate on the shared detail lock so Start cannot race a committed-but-unrefreshed write.
    // Do NOT enter beginWrite/commitWrite — Start does not advance identity CAS, so the lock
    // would permanently flip to refreshFailed after every successful Start.
    if (lock.isLocked()) return;
    const committed = await runAdminMutation({
      authMethod,
      run: async () => {
        await adminAgentsService.startRollout({
          agentId: snapshot.identity.id,
          assignmentId,
          expectedDraftToken: snapshot.draftToken,
          expectedRevision: snapshot.identity.revision,
        });
      },
    });
    if (!committed) return;
    // Job-specific path: refresh detail for the new rollout row without identity CAS gating.
    try {
      await refresh();
    } catch {
      toast.error(t('agentCatalog.rollout.refreshFailed'));
    }
    toast.success(t('agentCatalog.rollout.started'));
  };

  return (
    <Flexbox gap={16}>
      <Text as="h3" fontSize={16} weight={600}>
        {t('agentCatalog.assignment.title')}
      </Text>

      {assignmentsTruncated ? (
        <Alert
          showIcon
          description={t('agentCatalog.collection.truncatedAssignments')}
          message={t('agentCatalog.collection.truncated')}
          type="warning"
          action={
            onLoadMoreAssignments ? (
              <Button
                loading={loadingMore}
                size="small"
                onClick={() => void onLoadMoreAssignments()}
              >
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

      {editor.refreshFailed ? (
        <Alert
          showIcon
          message={t('agentCatalog.recovery.refreshFailed')}
          type="warning"
          action={
            <Button size="small" onClick={editor.retryRefresh}>
              {t('agentCatalog.recovery.refreshRetry')}
            </Button>
          }
        />
      ) : null}

      {permissions.canAssign ? (
        <Block padding={16} variant="outlined">
          <Flexbox gap={12}>
            <Text strong>
              {editor.editingId
                ? t('agentCatalog.assignment.editingExisting')
                : t('agentCatalog.assignment.createNew')}
            </Text>
            <Flexbox horizontal gap={8} wrap="wrap">
              <Select
                aria-label={t('agentCatalog.assignment.targetType')}
                value={editor.targetType}
                options={(['global', 'global_role', 'user'] as const).map((value) => ({
                  label: t(`agentCatalog.assignment.target.${value}` as never),
                  value,
                }))}
                onChange={(value) => editor.setTargetType(value as typeof editor.targetType)}
              />
              {editor.targetType !== 'global' ? (
                <Input
                  aria-label={t('agentCatalog.assignment.targetId')}
                  placeholder={t('agentCatalog.assignment.targetId')}
                  value={editor.targetId}
                  onChange={(event) => editor.setTargetId(event.target.value)}
                />
              ) : null}
              <Select
                aria-label={t('agentCatalog.assignment.mode')}
                value={editor.mode}
                options={(['mandatory', 'default', 'optional'] as const).map((value) => ({
                  label: t(`agentCatalog.assignment.mode.${value}` as never),
                  value,
                }))}
                onChange={(value) => editor.setMode(value as typeof editor.mode)}
              />
              <Select
                aria-label={t('agentCatalog.assignment.versionPolicy')}
                value={editor.versionPolicy}
                options={(['latest_published', 'pinned'] as const).map((value) => ({
                  label: t(`agentCatalog.assignment.versionPolicy.${value}` as never),
                  value,
                }))}
                onChange={(value) => editor.setVersionPolicy(value as typeof editor.versionPolicy)}
              />
              {editor.versionPolicy === 'pinned' ? (
                <Select
                  aria-label={t('agentCatalog.assignment.pinnedVersion')}
                  placeholder={t('agentCatalog.assignment.pinnedVersion')}
                  value={editor.pinnedVersionId ?? undefined}
                  options={snapshot.versions.map((version) => ({
                    label: version.version,
                    value: version.id,
                  }))}
                  onChange={(value) =>
                    editor.setPinnedVersionId((value as string | undefined) ?? null)
                  }
                />
              ) : null}
            </Flexbox>
            <Flexbox horizontal align="center" gap={8}>
              <Switch checked={editor.enabled} onChange={(value) => editor.setEnabled(value)} />
              <Text>{t('agentCatalog.assignment.enabled')}</Text>
            </Flexbox>
            {editor.error ? <Alert message={editor.error} type="error" /> : null}
            {editor.preview ? (
              <Alert
                type={editor.preview.warnings.length ? 'warning' : 'info'}
                description={editor.preview.warnings
                  .map((warning) => t(`agentCatalog.assignment.warning.${warning}` as never))
                  .join(' · ')}
                message={t('agentCatalog.assignment.previewResult', {
                  count: editor.preview.estimatedUsers,
                })}
              />
            ) : null}
            <Flexbox horizontal gap={8} wrap="wrap">
              <Button
                disabled={editor.busy || editor.locked || Boolean(editor.validationError)}
                onClick={() => void editor.previewAssignment()}
              >
                {t('agentCatalog.assignment.preview')}
              </Button>
              <Button
                disabled={editor.busy || editor.locked || Boolean(editor.validationError)}
                type="primary"
                onClick={() => void editor.submit()}
              >
                {editor.editingId
                  ? t('agentCatalog.assignment.update')
                  : t('agentCatalog.assignment.create')}
              </Button>
              {editor.editingId ? (
                <Button onClick={editor.resetForm}>
                  {t('agentCatalog.assignment.cancelEdit')}
                </Button>
              ) : null}
            </Flexbox>
          </Flexbox>
        </Block>
      ) : (
        <Alert message={t('agentCatalog.readOnly.assignment')} type="info" />
      )}

      {snapshot.assignments.length === 0 ? (
        <Text type="secondary">{t('agentCatalog.assignment.empty')}</Text>
      ) : (
        snapshot.assignments.map((assignment) => (
          <Block key={assignment.id} padding={16} variant="outlined">
            <Flexbox horizontal align="center" gap={12} justify="space-between" wrap="wrap">
              <Flexbox gap={4}>
                <Flexbox horizontal gap={6} wrap="wrap">
                  <Tag>{t(`agentCatalog.assignment.mode.${assignment.mode}` as never)}</Tag>
                  <Tag>{t(`agentCatalog.assignment.target.${assignment.targetType}` as never)}</Tag>
                  <Tag>
                    {t(
                      `agentCatalog.assignment.versionPolicy.${assignment.versionPolicy}` as never,
                    )}
                  </Tag>
                  {assignment.enabled ? null : (
                    <Tag color="warning">{t('agentCatalog.assignment.disabledTag')}</Tag>
                  )}
                </Flexbox>
                <Text code type="secondary">
                  {assignment.targetId}
                </Text>
              </Flexbox>
              {permissions.canAssign ? (
                <Flexbox horizontal gap={8}>
                  <Button disabled={editor.locked} onClick={() => editor.edit(assignment)}>
                    {t('agentCatalog.assignment.edit')}
                  </Button>
                  {rolloutsEnabled && snapshot.identity.systemKey !== 'default-inbox' ? (
                    <Button
                      disabled={editor.locked}
                      onClick={() => void startRollout(assignment.id)}
                    >
                      {t('agentCatalog.rollout.start')}
                    </Button>
                  ) : (
                    <Tooltip
                      title={
                        snapshot.identity.systemKey === 'default-inbox'
                          ? t('agentCatalog.rollout.defaultInboxDelegated')
                          : t('agentCatalog.rollout.deferred')
                      }
                    >
                      <Button disabled>{t('agentCatalog.rollout.start')}</Button>
                    </Tooltip>
                  )}
                  <Button danger disabled={editor.locked} onClick={() => editor.remove(assignment)}>
                    {t('agentCatalog.assignment.remove')}
                  </Button>
                </Flexbox>
              ) : null}
            </Flexbox>
          </Block>
        ))
      )}
    </Flexbox>
  );
};
