'use client';

import { Alert, Flexbox, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import RevisionBanner from '../primitives/RevisionBanner';
import ConnectorEditorFields from './ConnectorEditorFields';
import type {
  AdminConnectorDraftValidation,
  AdminConnectorPermissions,
  AdminConnectorPrimaryAction,
  EditableAdminConnectorDraft,
} from './controller';
import ToolPolicyEditor from './ToolPolicyEditor';
import type { AdminConnectorGetOutput, AdminConnectorToolDraft } from './types';

const styles = createStaticStyles(({ css }) => ({
  footer: css`
    position: sticky;
    z-index: 2;
    inset-block-end: 0;

    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
    justify-content: space-between;

    padding-block: 16px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};

    background: ${cssVar.colorBgLayout};
  `,
}));

export type AdminConnectorSaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'failed';

interface ConnectorDetailViewProps {
  actionError: string | null;
  busyAction: string | null;
  conflict: boolean;
  draft: EditableAdminConnectorDraft;
  onArchive: () => void;
  onChange: <Key extends keyof EditableAdminConnectorDraft>(
    key: Key,
    value: EditableAdminConnectorDraft[Key],
  ) => void;
  onDiscardConflict: () => void;
  onDiscover: () => void;
  onPrimaryAction: (action: AdminConnectorPrimaryAction) => void;
  onRefreshConflict: () => void;
  onRevokeBindings: () => void;
  onSecretChange: (secret: string) => void;
  onToolChange: (
    toolId: string,
    patch: Partial<
      Pick<
        AdminConnectorToolDraft,
        'enabled' | 'platformPolicy' | 'requiresConfirmation' | 'riskLevel'
      >
    >,
  ) => void;
  permissions: AdminConnectorPermissions;
  primaryAction: AdminConnectorPrimaryAction;
  saveState: AdminConnectorSaveState;
  secretValue: string;
  snapshot: AdminConnectorGetOutput;
  validation: AdminConnectorDraftValidation;
}

const ConnectorDetailView = memo<ConnectorDetailViewProps>(
  ({
    actionError,
    busyAction,
    conflict,
    draft,
    onArchive,
    onChange,
    onDiscover,
    onDiscardConflict,
    onPrimaryAction,
    onRefreshConflict,
    onRevokeBindings,
    onSecretChange,
    onToolChange,
    permissions,
    primaryAction,
    saveState,
    secretValue,
    snapshot,
    validation,
  }) => {
    const { t } = useTranslation('admin');
    const readOnly = !permissions.canUpdate;
    const secretConfigured =
      snapshot.draft.credentialMode === 'shared_service_account'
        ? snapshot.draft.sharedSecret.configured
        : snapshot.draft.credentialMode === 'per_user_oauth'
          ? snapshot.draft.oauthClientSecret.configured
          : false;

    return (
      <AdminPageTemplate
        description={t('connectorCatalog.detail.description')}
        title={snapshot.draft.displayName}
        actions={
          <Flexbox horizontal gap={8}>
            {permissions.canDiscover ? (
              <Button disabled={conflict || Boolean(busyAction)} onClick={onDiscover}>
                {t('connectorCatalog.actions.discover')}
              </Button>
            ) : null}
            {permissions.canRevokeBindings && snapshot.published ? (
              <Button danger disabled={conflict || Boolean(busyAction)} onClick={onRevokeBindings}>
                {t('connectorCatalog.actions.revokeBindings')}
              </Button>
            ) : null}
            {permissions.canArchive && snapshot.published ? (
              <Button danger disabled={conflict || Boolean(busyAction)} onClick={onArchive}>
                {t('connectorCatalog.actions.archive')}
              </Button>
            ) : null}
          </Flexbox>
        }
        banner={
          <>
            <RevisionBanner
              conflict={conflict}
              draftRevision={snapshot.baseRevision}
              publishedRevision={snapshot.published?.publishedRevision ?? null}
              status={snapshot.draft.status}
            />
            {readOnly ? (
              <Alert showIcon message={t('connectorCatalog.readOnly')} type={'info'} />
            ) : null}
            {conflict ? (
              <Alert
                showIcon
                description={t('connectorCatalog.conflict.description')}
                message={t('connectorCatalog.conflict.title')}
                type={'warning'}
                extra={
                  <Flexbox horizontal gap={8}>
                    <Button onClick={onRefreshConflict}>
                      {t('connectorCatalog.conflict.refresh')}
                    </Button>
                    <Button onClick={onDiscardConflict}>
                      {t('connectorCatalog.conflict.discard')}
                    </Button>
                  </Flexbox>
                }
              />
            ) : null}
            {actionError ? <Alert showIcon message={actionError} type={'error'} /> : null}
          </>
        }
      >
        <Flexbox gap={16}>
          <ConnectorEditorFields
            disabled={readOnly || conflict || Boolean(busyAction)}
            draft={draft}
            errors={validation.errors}
            secretConfigured={secretConfigured}
            secretValue={secretValue}
            onChange={onChange}
            onSecretChange={onSecretChange}
          />
          <ToolPolicyEditor
            disabled={readOnly || conflict || Boolean(busyAction)}
            tools={draft.tools}
            onChange={onToolChange}
          />
          <div className={styles.footer}>
            <Text type={saveState === 'failed' ? 'danger' : 'secondary'}>
              {t(`connectorCatalog.saveState.${saveState}` as never)}
            </Text>
            <Flexbox horizontal gap={8}>
              {permissions.canTest ? (
                <Button
                  disabled={conflict || Boolean(busyAction) || !validation.valid}
                  loading={busyAction === 'test'}
                  type={primaryAction === 'test' ? 'primary' : undefined}
                  onClick={() => onPrimaryAction('test')}
                >
                  {t('connectorCatalog.actions.test')}
                </Button>
              ) : null}
              {primaryAction === 'save' || primaryAction === 'retry' ? (
                <Button
                  disabled={conflict || Boolean(busyAction) || !validation.valid}
                  loading={busyAction === 'save'}
                  type={'primary'}
                  onClick={() => onPrimaryAction(primaryAction)}
                >
                  {t(
                    primaryAction === 'retry'
                      ? 'connectorCatalog.actions.retrySave'
                      : 'connectorCatalog.actions.save',
                  )}
                </Button>
              ) : null}
              {primaryAction === 'publish' ? (
                <Button
                  disabled={conflict || Boolean(busyAction)}
                  loading={busyAction === 'publish'}
                  type={'primary'}
                  onClick={() => onPrimaryAction('publish')}
                >
                  {t('connectorCatalog.actions.publish')}
                </Button>
              ) : null}
            </Flexbox>
          </div>
        </Flexbox>
      </AdminPageTemplate>
    );
  },
);

ConnectorDetailView.displayName = 'AdminConnectorDetailView';

export default ConnectorDetailView;
