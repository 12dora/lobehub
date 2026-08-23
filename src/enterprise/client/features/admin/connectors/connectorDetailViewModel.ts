import type {
  AdminConnectorDraftValidation,
  AdminConnectorPermissions,
  AdminConnectorPrimaryAction,
  EditableAdminConnectorDraft,
} from './controller';
import type { AdminConnectorGetOutput } from './types';

export type AdminConnectorSaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'failed';

/** Header actions the operator may see, and the single predicate that gates all of them. */
export interface ConnectorDetailHeaderActionsModel {
  /**
   * Every header action is a revision-scoped mutation on the server copy, so it stays blocked
   * while the local draft is unsettled (conflict / unsaved edits / another action in flight).
   */
  disabled: boolean;
  rollbackLoading: boolean;
  showArchive: boolean;
  showDeleteDraft: boolean;
  showDiscover: boolean;
  showRevokeBindings: boolean;
  showRollback: boolean;
}

/** A footer button that is rendered, or `null` when this operator/state has none. */
export interface ConnectorDetailFooterButtonModel {
  disabled: boolean;
  loading: boolean;
}

export interface ConnectorDetailFooterModel {
  publish: ConnectorDetailFooterButtonModel | null;
  save: (ConnectorDetailFooterButtonModel & { action: 'retry' | 'save'; labelKey: string }) | null;
  saveStateTone: 'danger' | 'secondary';
  test: (ConnectorDetailFooterButtonModel & { primary: boolean }) | null;
}

export interface ConnectorDetailViewModel {
  /** Draft editors are locked whenever the edit cannot be trusted to land. */
  editorDisabled: boolean;
  footer: ConnectorDetailFooterModel;
  headerActions: ConnectorDetailHeaderActionsModel;
  readOnly: boolean;
  /** Whether a stored secret exists for the credential mode currently selected in the draft. */
  secretConfigured: boolean;
}

/**
 * A pending credential-mode switch invalidates the persisted secret state: the stored bytes belong
 * to the mode on the server snapshot, not to the one the operator just picked.
 */
export const resolveConnectorSecretConfigured = (
  draft: EditableAdminConnectorDraft,
  snapshot: AdminConnectorGetOutput,
): boolean => {
  if (draft.credentialMode !== snapshot.draft.credentialMode) return false;
  if (draft.credentialMode === 'shared_service_account') {
    return snapshot.draft.sharedSecret.configured;
  }
  if (draft.credentialMode === 'per_user_oauth') {
    return snapshot.draft.oauthClientSecret.configured;
  }
  return false;
};

export interface ConnectorDetailViewModelInput {
  busyAction: string | null;
  conflict: boolean;
  draft: EditableAdminConnectorDraft;
  permissions: AdminConnectorPermissions;
  primaryAction: AdminConnectorPrimaryAction;
  saveState: AdminConnectorSaveState;
  snapshot: AdminConnectorGetOutput;
  validation: AdminConnectorDraftValidation;
}

/**
 * Resolves "what this connector is" for the detail screen once, so the view renders a decided
 * shape instead of re-deriving permission / revision / busy checks at every button.
 */
export const resolveConnectorDetailViewModel = ({
  busyAction,
  conflict,
  draft,
  permissions,
  primaryAction,
  saveState,
  snapshot,
  validation,
}: ConnectorDetailViewModelInput): ConnectorDetailViewModel => {
  const busy = Boolean(busyAction);
  const readOnly = !permissions.canUpdate;
  const hasUnsavedChanges =
    saveState === 'dirty' || saveState === 'failed' || saveState === 'saving';
  /** The server copy matches what the operator sees and nothing is in flight. */
  const settled = !conflict && !hasUnsavedChanges && !busy;
  const published = Boolean(snapshot.published);
  const isSaveAction = primaryAction === 'save' || primaryAction === 'retry';

  return {
    editorDisabled: readOnly || conflict || busy,
    footer: {
      publish:
        primaryAction === 'publish'
          ? { disabled: conflict || busy, loading: busyAction === 'publish' }
          : null,
      save: isSaveAction
        ? {
            action: primaryAction,
            disabled: conflict || busy || !validation.valid,
            labelKey:
              primaryAction === 'retry'
                ? 'connectorCatalog.actions.retrySave'
                : 'connectorCatalog.actions.save',
            loading: busyAction === 'save',
          }
        : null,
      saveStateTone: saveState === 'failed' ? 'danger' : 'secondary',
      test: permissions.canTest
        ? {
            disabled: !settled || !validation.valid,
            loading: busyAction === 'test',
            primary: primaryAction === 'test',
          }
        : null,
    },
    headerActions: {
      disabled: !settled,
      rollbackLoading: busyAction === 'rollback',
      showArchive: permissions.canArchive && published,
      showDeleteDraft: permissions.canDelete && !published,
      showDiscover: permissions.canDiscover,
      showRevokeBindings: permissions.canRevokeBindings && published,
      showRollback: permissions.canPublish && published,
    },
    readOnly,
    secretConfigured: resolveConnectorSecretConfigured(draft, snapshot),
  };
};
