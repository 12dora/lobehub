'use client';

import { Alert, Block, Flexbox, Tag, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import type { KeyedMutator } from 'swr';

import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { adminAgentsService } from '@/enterprise/client/services/adminAgents';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import StatusBadge from '../primitives/StatusBadge';
import { AgentEditorFields } from './AgentEditorFields';
import { AssignmentPanel } from './AssignmentPanel';
import type { deriveAdminAgentPermissions } from './controller';
import { deriveAdminAgentActionAvailability } from './controller';
import { DependencyEditor } from './DependencyEditor';
import { RolloutPanel } from './RolloutPanel';
import type { AdminAgentDetailOutput } from './types';
import { useAgentActions } from './useAgentActions';
import type { useAgentEditor } from './useAgentEditor';

interface AgentDetailViewProps {
  authMethod: AdminReauthAuthMethod | null;
  editor: ReturnType<typeof useAgentEditor>;
  mutate: KeyedMutator<AdminAgentDetailOutput>;
  permissions: ReturnType<typeof deriveAdminAgentPermissions>;
  snapshot: AdminAgentDetailOutput;
}

const PERSIST_HINT_KEY = {
  blocked: 'agentCatalog.recovery.blocked',
  saved: 'agentCatalog.recovery.saved',
  too_large: 'agentCatalog.recovery.tooLarge',
  unavailable: 'agentCatalog.recovery.unavailable',
} as const;

export const AgentDetailView = memo(
  ({ authMethod, editor, mutate, permissions, snapshot }: AgentDetailViewProps) => {
    const { t } = useTranslation('admin');
    const current = snapshot.versions.find(({ id }) => id === snapshot.identity.currentVersionId);
    const latest = snapshot.versions[0];
    const modelReady = Boolean(editor.draft?.dependencies.model);
    const availability = deriveAdminAgentActionAvailability({
      dirty: editor.dirty,
      hasCurrentVersion: Boolean(latest),
      permissions,
    });
    const actions = useAgentActions({ authMethod, editor, mutate, permissions, snapshot });

    return (
      <AdminPageTemplate
        description={snapshot.identity.agentKey}
        title={current?.config.displayName ?? snapshot.identity.agentKey}
        actions={
          <Flexbox horizontal gap={8} wrap="wrap">
            {availability.canSaveVersion && editor.draft ? (
              <Button
                type="primary"
                disabled={
                  !editor.dirty || editor.conflict || editor.saveState === 'saving' || !modelReady
                }
                onClick={actions.save}
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
                onClick={() => actions.publish(latest.id)}
              >
                {t('agentCatalog.publish.submit')}
              </Button>
            ) : null}
            {permissions.canPublish &&
            !snapshot.identity.isDefault &&
            snapshot.identity.status === 'published' ? (
              <Button
                danger
                disabled={!availability.canPublishNow}
                onClick={() => void actions.setDefaultInbox()}
              >
                {t('agentCatalog.defaultSwitch.submit')}
              </Button>
            ) : null}
            {permissions.canDelete ? (
              <Button
                danger
                disabled={!availability.canArchiveNow}
                onClick={() => void actions.archive()}
              >
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
          {actions.refreshFailed ? (
            <Alert
              showIcon
              description={t('agentCatalog.recovery.refreshFailedDescription')}
              message={t('agentCatalog.recovery.refreshFailed')}
              type="warning"
              action={
                <Button size="small" onClick={() => void actions.retryRefresh()}>
                  {t('agentCatalog.recovery.refreshRetry')}
                </Button>
              }
            />
          ) : null}
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
          {editor.persistState && editor.persistState !== 'saved' ? (
            <Alert showIcon message={t(PERSIST_HINT_KEY[editor.persistState])} type="warning" />
          ) : editor.persistState === 'saved' ? (
            <Text type="secondary">{t(PERSIST_HINT_KEY.saved)}</Text>
          ) : null}
          {editor.draft ? (
            <Block padding={20} variant="outlined">
              <Flexbox gap={20}>
                <AgentEditorFields
                  draft={editor.draft}
                  editable={permissions.canUpdate}
                  onChange={editor.updateDraft}
                />
                <DependencyEditor
                  dependencies={editor.draft.dependencies}
                  editable={permissions.canUpdate}
                  enabled={permissions.canUpdate}
                  onChange={(next) =>
                    editor.updateDraft((currentDraft) => ({
                      ...currentDraft,
                      dependencies: next,
                    }))
                  }
                />
              </Flexbox>
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
                      onClick={() => actions.rollback(version.id)}
                    >
                      {t('agentCatalog.rollback.submit')}
                    </Button>
                  ) : null}
                </Flexbox>
              </Block>
            ))}
          </Flexbox>
          <AssignmentPanel
            authMethod={authMethod}
            mutate={mutate}
            permissions={permissions}
            rolloutsEnabled={adminAgentsService.capabilities.rollouts}
            snapshot={snapshot}
          />
          <RolloutPanel
            enabled={adminAgentsService.capabilities.rollouts}
            permissions={permissions}
            refresh={mutate}
            snapshot={snapshot}
          />
        </Flexbox>
      </AdminPageTemplate>
    );
  },
);

AgentDetailView.displayName = 'AgentDetailView';
