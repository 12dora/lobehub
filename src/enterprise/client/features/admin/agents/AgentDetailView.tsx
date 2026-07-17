'use client';

import { Alert, Block, Flexbox, Tag, Text } from '@lobehub/ui';
import { Button, toast } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { adminAgentsService } from '@/enterprise/client/services/adminAgents';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import StatusBadge from '../primitives/StatusBadge';
import { AgentEditorFields } from './AgentEditorFields';
import { AssignmentPanel } from './AssignmentPanel';
import type { deriveAdminAgentPermissions } from './controller';
import { deriveAdminAgentActionAvailability } from './controller';
import { openAgentReasonModal } from './openAgentReasonModal';
import { openArchiveAgentModal } from './openArchiveAgentModal';
import { RolloutPanel } from './RolloutPanel';
import type { AdminAgentDetailOutput } from './types';
import { fetchAllAdminAgents } from './useAdminAgents';
import type { useAgentEditor } from './useAgentEditor';

interface AgentDetailViewProps {
  editor: ReturnType<typeof useAgentEditor>;
  permissions: ReturnType<typeof deriveAdminAgentPermissions>;
  refresh: () => Promise<AdminAgentDetailOutput | undefined>;
  snapshot: AdminAgentDetailOutput;
}

export const AgentDetailView = memo(
  ({ editor, permissions, refresh, snapshot }: AgentDetailViewProps) => {
    const { t } = useTranslation('admin');
    const current = snapshot.versions.find(({ id }) => id === snapshot.identity.currentVersionId);
    const latest = snapshot.versions[0];
    const availability = deriveAdminAgentActionAvailability({
      dirty: editor.dirty,
      hasCurrentVersion: Boolean(latest),
      permissions,
    });

    const save = async (reason: string) => {
      if (!editor.draft) return;
      editor.setSaveState('saving');
      try {
        await adminAgentsService.appendVersion({
          agentId: snapshot.identity.id,
          config: editor.draft.config,
          dependencySnapshot: editor.draft.dependencySnapshot,
          expectedDraftToken: snapshot.draftToken,
          expectedRevision: snapshot.identity.revision,
          reason,
          version: editor.draft.version,
        });
        editor.markSaved();
        await refresh();
        toast.success(t('agentCatalog.toast.saved'));
      } catch (cause) {
        editor.setSaveState('failed');
        if (cause instanceof Error && cause.message.includes('CONFLICT')) editor.setConflict(true);
        toast.error(cause instanceof Error ? cause.message : String(cause));
      }
    };

    const openSave = () =>
      openAgentReasonModal({
        description: t('agentCatalog.save.description'),
        onConfirm: save,
        submitLabel: t('agentCatalog.action.saveVersion'),
        title: t('agentCatalog.save.title'),
      });

    const publishVersion = (versionId: string) =>
      openAgentReasonModal({
        description: t('agentCatalog.publish.description'),
        onConfirm: async (reason) => {
          await adminAgentsService.publish({
            agentId: snapshot.identity.id,
            expectedDraftToken: snapshot.draftToken,
            expectedRevision: snapshot.identity.revision,
            reason,
            versionId,
          });
          await refresh();
          toast.success(t('agentCatalog.toast.published'));
        },
        submitLabel: t('agentCatalog.publish.submit'),
        title: t('agentCatalog.publish.title'),
      });

    const rollback = (versionId: string) =>
      openAgentReasonModal({
        danger: true,
        description: t('agentCatalog.rollback.description'),
        onConfirm: async (reason) => {
          await adminAgentsService.rollback({
            agentId: snapshot.identity.id,
            expectedDraftToken: snapshot.draftToken,
            expectedRevision: snapshot.identity.revision,
            reason,
            targetVersionId: versionId,
          });
          await refresh();
          toast.success(t('agentCatalog.toast.rolledBack'));
        },
        submitLabel: t('agentCatalog.rollback.submit'),
        title: t('agentCatalog.rollback.title'),
      });

    const setDefaultInbox = () =>
      openAgentReasonModal({
        danger: true,
        description: t('agentCatalog.defaultSwitch.description'),
        onConfirm: async (reason) => {
          const currentDefaultIdentity = (await fetchAllAdminAgents({}, adminAgentsService)).find(
            ({ identity }) => identity.isDefault,
          )?.identity;
          const currentDefault =
            currentDefaultIdentity && currentDefaultIdentity.id !== snapshot.identity.id
              ? await adminAgentsService.get({ id: currentDefaultIdentity.id })
              : null;
          await adminAgentsService.setDefaultInbox({
            currentDefault: currentDefault
              ? {
                  agentId: currentDefault.identity.id,
                  expectedDraftToken: currentDefault.draftToken,
                  expectedRevision: currentDefault.identity.revision,
                }
              : null,
            nextDefault: {
              agentId: snapshot.identity.id,
              expectedDraftToken: snapshot.draftToken,
              expectedRevision: snapshot.identity.revision,
            },
            reason,
          });
          await refresh();
          toast.success(t('agentCatalog.defaultSwitch.success'));
        },
        submitLabel: t('agentCatalog.defaultSwitch.submit'),
        title: t('agentCatalog.defaultSwitch.title'),
      });

    const archive = async () => {
      const candidates = snapshot.identity.isDefault
        ? (await fetchAllAdminAgents({ status: 'published' }, adminAgentsService))
            .filter(({ identity }) => identity.id !== snapshot.identity.id)
            .map(({ displayName, identity }) => ({ label: displayName, value: identity.id }))
        : [];
      openArchiveAgentModal({
        candidates,
        isDefault: snapshot.identity.isDefault,
        onConfirm: async (reason, replacementAgentId) => {
          await adminAgentsService.archive({
            agentId: snapshot.identity.id,
            expectedDraftToken: snapshot.draftToken,
            expectedRevision: snapshot.identity.revision,
            reason,
            replacementAgentId,
          });
          await refresh();
          toast.success(t('agentCatalog.toast.archived'));
        },
      });
    };

    return (
      <AdminPageTemplate
        description={snapshot.identity.agentKey}
        title={current?.config.displayName ?? snapshot.identity.agentKey}
        actions={
          <Flexbox horizontal gap={8} wrap="wrap">
            {availability.canSaveVersion && editor.draft ? (
              <Button
                disabled={!editor.dirty || editor.conflict || editor.saveState === 'saving'}
                type="primary"
                onClick={openSave}
              >
                {editor.saveState === 'saving'
                  ? t('agentCatalog.action.saving')
                  : t('agentCatalog.action.saveVersion')}
              </Button>
            ) : null}
            {permissions.canPublish &&
            latest &&
            (latest.id !== current?.id || snapshot.identity.status !== 'published') ? (
              <Button
                disabled={!availability.canPublishNow}
                onClick={() => publishVersion(latest.id)}
              >
                {t('agentCatalog.publish.submit')}
              </Button>
            ) : null}
            {permissions.canPublish &&
            !snapshot.identity.isDefault &&
            snapshot.identity.status === 'published' ? (
              <Button danger disabled={!availability.canPublishNow} onClick={setDefaultInbox}>
                {t('agentCatalog.defaultSwitch.submit')}
              </Button>
            ) : null}
            {permissions.canDelete ? (
              <Button danger disabled={!availability.canArchiveNow} onClick={() => void archive()}>
                {t('agentCatalog.archive.submit')}
              </Button>
            ) : null}
          </Flexbox>
        }
      >
        <Flexbox gap={24}>
          <Flexbox horizontal gap={8} wrap="wrap">
            <StatusBadge status={snapshot.identity.status} />
            {snapshot.identity.isDefault ? <Tag>{t('agentCatalog.defaultInbox')}</Tag> : null}
            {snapshot.identity.migrationRequired ? (
              <Tag color="warning">{t('agentCatalog.migrationRequired')}</Tag>
            ) : null}
            {!permissions.canUpdate ? <Tag>{t('agentCatalog.readOnly.badge')}</Tag> : null}
            <Text type="secondary">
              {t('agentCatalog.revision', { revision: snapshot.identity.revision })}
            </Text>
          </Flexbox>
          {editor.conflict ? (
            <Alert
              description={t('agentCatalog.conflict.description')}
              message={t('agentCatalog.conflict.title')}
              type="error"
              action={
                <Button size="small" onClick={editor.discard}>
                  {t('agentCatalog.conflict.discard')}
                </Button>
              }
            />
          ) : null}
          {editor.saveState === 'failed' ? (
            <Alert message={t('agentCatalog.save.failed')} type="error" />
          ) : null}
          {editor.draft ? (
            <Block padding={20} variant="outlined">
              <AgentEditorFields
                draft={editor.draft}
                editable={permissions.canUpdate}
                onChange={editor.updateDraft}
              />
            </Block>
          ) : null}
          <Flexbox gap={12}>
            <Text as="h3" fontSize={16} weight={600}>
              {t('agentCatalog.versions.title')}
            </Text>
            {snapshot.versions.length === 0 ? (
              <Text type="secondary">{t('agentCatalog.versions.empty')}</Text>
            ) : null}
            {snapshot.versions.map((version) => (
              <Block key={version.id} padding={16} variant="outlined">
                <Flexbox horizontal align="center" gap={12} justify="space-between" wrap="wrap">
                  <Flexbox gap={4}>
                    <Flexbox horizontal gap={8}>
                      <Text strong>{version.version}</Text>
                      {version.id === snapshot.identity.currentVersionId ? (
                        <Tag color="success">{t('agentCatalog.versions.current')}</Tag>
                      ) : null}
                    </Flexbox>
                    <Text type="secondary">
                      {version.dependencySnapshot.model.providerKey}/
                      {version.dependencySnapshot.model.modelKey} ·{' '}
                      {version.dependencySnapshot.skills.length} {t('agentCatalog.versions.skills')}{' '}
                      · {version.dependencySnapshot.connectors.length}{' '}
                      {t('agentCatalog.versions.connectors')}
                    </Text>
                    <Text code type="secondary">
                      {version.checksum.slice(0, 16)}…
                    </Text>
                  </Flexbox>
                  {permissions.canPublish &&
                  version.id !== snapshot.identity.currentVersionId &&
                  !(snapshot.identity.status === 'draft' && version.id === latest?.id) ? (
                    <Button
                      danger
                      disabled={!availability.canRollbackNow}
                      onClick={() => rollback(version.id)}
                    >
                      {t('agentCatalog.rollback.submit')}
                    </Button>
                  ) : null}
                </Flexbox>
              </Block>
            ))}
          </Flexbox>
          <AssignmentPanel
            permissions={permissions}
            refresh={refresh}
            rolloutsEnabled={adminAgentsService.capabilities.rollouts}
            snapshot={snapshot}
          />
          <RolloutPanel
            enabled={adminAgentsService.capabilities.rollouts}
            permissions={permissions}
            refresh={refresh}
            snapshot={snapshot}
          />
        </Flexbox>
      </AdminPageTemplate>
    );
  },
);

AgentDetailView.displayName = 'AgentDetailView';
