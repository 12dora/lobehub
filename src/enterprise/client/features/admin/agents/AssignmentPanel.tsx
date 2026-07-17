import { Alert, Block, Flexbox, Input, Tag, Text, Tooltip } from '@lobehub/ui';
import { Button, Select, toast } from '@lobehub/ui/base-ui';
import { useTranslation } from 'react-i18next';

import { adminAgentsService } from '@/enterprise/client/services/adminAgents';

import type { deriveAdminAgentPermissions } from './controller';
import { openAgentReasonModal } from './openAgentReasonModal';
import type { AdminAgentDetailOutput } from './types';
import { useAssignmentEditor } from './useAssignmentEditor';

interface AssignmentPanelProps {
  permissions: ReturnType<typeof deriveAdminAgentPermissions>;
  refresh: () => Promise<AdminAgentDetailOutput | undefined>;
  /** Whether the Rollout backend (PR-052) is available; off ⇒ Start rollout is gated/deferred. */
  rolloutsEnabled: boolean;
  snapshot: AdminAgentDetailOutput;
}

export const AssignmentPanel = ({
  permissions,
  refresh,
  rolloutsEnabled,
  snapshot,
}: AssignmentPanelProps) => {
  const { t } = useTranslation('admin');
  const editor = useAssignmentEditor(snapshot, refresh);

  const remove = (assignmentId: string) =>
    openAgentReasonModal({
      danger: true,
      description: t('agentCatalog.assignment.removeDescription'),
      onConfirm: async (reason) => {
        await adminAgentsService.removeAssignment({
          agentId: snapshot.identity.id,
          assignmentId,
          expectedDraftToken: snapshot.draftToken,
          expectedRevision: snapshot.identity.revision,
          reason,
        });
        await refresh();
        toast.success(t('agentCatalog.assignment.removed'));
      },
      submitLabel: t('agentCatalog.assignment.remove'),
      title: t('agentCatalog.assignment.remove'),
    });

  const start = (assignmentId: string) =>
    openAgentReasonModal({
      description: t('agentCatalog.rollout.startDescription'),
      onConfirm: async (reason) => {
        await adminAgentsService.startRollout({
          agentId: snapshot.identity.id,
          assignmentId,
          expectedDraftToken: snapshot.draftToken,
          expectedRevision: snapshot.identity.revision,
          reason,
        });
        await refresh();
        toast.success(t('agentCatalog.rollout.started'));
      },
      submitLabel: t('agentCatalog.rollout.start'),
      title: t('agentCatalog.rollout.start'),
    });

  return (
    <Flexbox gap={16}>
      <Text as="h3" fontSize={16} weight={600}>
        {t('agentCatalog.assignment.title')}
      </Text>
      {permissions.canAssign ? (
        <Block padding={16} variant="outlined">
          <Flexbox gap={12}>
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
            </Flexbox>
            <Input
              aria-label={t('agentCatalog.reason.label')}
              placeholder={t('agentCatalog.reason.placeholder')}
              value={editor.reason}
              onChange={(event) => editor.setReason(event.target.value)}
            />
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
            <Flexbox horizontal gap={8}>
              <Button
                disabled={
                  editor.busy || (editor.targetType !== 'global' && !editor.targetId.trim())
                }
                onClick={() => void editor.previewAssignment()}
              >
                {t('agentCatalog.assignment.preview')}
              </Button>
              <Button
                type="primary"
                disabled={
                  editor.busy ||
                  !editor.reason.trim() ||
                  (editor.targetType !== 'global' && !editor.targetId.trim())
                }
                onClick={() => void editor.createAssignment()}
              >
                {t('agentCatalog.assignment.create')}
              </Button>
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
                <Flexbox horizontal gap={6}>
                  <Tag>{t(`agentCatalog.assignment.mode.${assignment.mode}` as never)}</Tag>
                  <Tag>{t(`agentCatalog.assignment.target.${assignment.targetType}` as never)}</Tag>
                  <Tag>
                    {t(
                      `agentCatalog.assignment.versionPolicy.${assignment.versionPolicy}` as never,
                    )}
                  </Tag>
                </Flexbox>
                <Text code type="secondary">
                  {assignment.targetId}
                </Text>
              </Flexbox>
              {permissions.canAssign ? (
                <Flexbox horizontal gap={8}>
                  {rolloutsEnabled ? (
                    <Button onClick={() => start(assignment.id)}>
                      {t('agentCatalog.rollout.start')}
                    </Button>
                  ) : (
                    <Tooltip title={t('agentCatalog.rollout.deferred')}>
                      <Button disabled>{t('agentCatalog.rollout.start')}</Button>
                    </Tooltip>
                  )}
                  <Button danger onClick={() => remove(assignment.id)}>
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
