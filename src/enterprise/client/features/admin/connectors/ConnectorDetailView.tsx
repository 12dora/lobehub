'use client';

import { Flexbox } from '@lobehub/ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import ConnectorAuditPanel from './ConnectorAuditPanel';
import ConnectorDetailBanner from './ConnectorDetailBanner';
import ConnectorDetailFooter from './ConnectorDetailFooter';
import ConnectorDetailHeaderActions from './ConnectorDetailHeaderActions';
import {
  type AdminConnectorSaveState,
  resolveConnectorDetailViewModel,
} from './connectorDetailViewModel';
import ConnectorEditorFields from './ConnectorEditorFields';
import type {
  AdminConnectorDraftValidation,
  AdminConnectorPermissions,
  AdminConnectorPrimaryAction,
  ConnectorSecretEdit,
  EditableAdminConnectorDraft,
} from './controller';
import ToolPolicyEditor from './ToolPolicyEditor';
import type { AdminConnectorGetOutput, AdminConnectorToolDraft } from './types';

// Kept exported here: the save-state union has always been part of this module's public surface.
export type { AdminConnectorSaveState };

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
  onDeleteDraft: () => void;
  onDiscardConflict: () => void;
  onDiscover: () => void;
  onPrimaryAction: (action: AdminConnectorPrimaryAction) => void;
  onRefreshConflict: () => void;
  onRevokeBindings: () => void;
  onRollback: () => void;
  onSecretChange: (secret: string) => void;
  onSecretClear: () => void;
  onSecretKeep: () => void;
  onToolChange: (
    toolId: string,
    patch: Partial<
      Pick<
        AdminConnectorToolDraft,
        'enabled' | 'platformPolicy' | 'requiresConfirmation' | 'riskLevel' | 'sort'
      >
    >,
  ) => void;
  permissions: AdminConnectorPermissions;
  primaryAction: AdminConnectorPrimaryAction;
  /** Localized notice after crash recovery of secret intent (clear / reentry). */
  restoreNotice?: string | null;
  saveState: AdminConnectorSaveState;
  secret: ConnectorSecretEdit;
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
    onDeleteDraft,
    onDiscardConflict,
    onPrimaryAction,
    onRefreshConflict,
    onRevokeBindings,
    onRollback,
    onSecretChange,
    onSecretClear,
    onSecretKeep,
    onToolChange,
    permissions,
    primaryAction,
    restoreNotice,
    saveState,
    secret,
    snapshot,
    validation,
  }) => {
    const { t } = useTranslation('admin');
    const view = resolveConnectorDetailViewModel({
      busyAction,
      conflict,
      draft,
      permissions,
      primaryAction,
      saveState,
      snapshot,
      validation,
    });

    return (
      <AdminPageTemplate
        description={t('connectorCatalog.detail.description')}
        title={snapshot.draft.displayName}
        actions={
          <ConnectorDetailHeaderActions
            model={view.headerActions}
            onArchive={onArchive}
            onDeleteDraft={onDeleteDraft}
            onDiscover={onDiscover}
            onRevokeBindings={onRevokeBindings}
            onRollback={onRollback}
          />
        }
        banner={
          <ConnectorDetailBanner
            actionError={actionError}
            conflict={conflict}
            readOnly={view.readOnly}
            restoreNotice={restoreNotice}
            snapshot={snapshot}
            onDiscardConflict={onDiscardConflict}
            onRefreshConflict={onRefreshConflict}
          />
        }
      >
        <Flexbox gap={16}>
          <ConnectorEditorFields
            disabled={view.editorDisabled}
            draft={draft}
            errors={validation.errors}
            secret={secret}
            secretConfigured={view.secretConfigured}
            onChange={onChange}
            onSecretChange={onSecretChange}
            onSecretClear={onSecretClear}
            onSecretKeep={onSecretKeep}
          />
          <ToolPolicyEditor
            disabled={view.editorDisabled}
            tools={draft.tools}
            onChange={onToolChange}
          />
          <ConnectorAuditPanel
            canReadAudit={permissions.canReadAudit}
            connectorId={snapshot.draft.id}
          />
          <ConnectorDetailFooter
            model={view.footer}
            saveState={saveState}
            onPrimaryAction={onPrimaryAction}
          />
        </Flexbox>
      </AdminPageTemplate>
    );
  },
);

ConnectorDetailView.displayName = 'AdminConnectorDetailView';

export default ConnectorDetailView;
