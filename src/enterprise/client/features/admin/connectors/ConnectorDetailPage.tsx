'use client';

import { memo } from 'react';
import { useParams } from 'react-router';

import AsyncBoundary from '@/components/AsyncBoundary';
import Loading from '@/components/Loading/BrandTextLoading';
import type { AdminAccessContextValue } from '@/enterprise/client/providers/AdminAccessProvider';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';

import ConnectorDetailView from './ConnectorDetailView';
import { deriveAdminConnectorPermissions } from './controller';
import type { AdminConnectorGetOutput } from './types';
import { useConnectorActions } from './useConnectorActions';
import { useConnectorEditor } from './useConnectorEditor';
import { useFetchAdminConnector } from './useMockableAdminConnectorCatalog';

interface ConnectorDetailContentProps {
  authMethod: AdminAccessContextValue['authMethod'];
  data: AdminConnectorGetOutput;
  editor: ReturnType<typeof useConnectorEditor>;
  mutate: () => Promise<AdminConnectorGetOutput | undefined>;
  permissions: ReturnType<typeof deriveAdminConnectorPermissions>;
}

const ConnectorDetailContent = memo(
  ({ authMethod, data, editor, mutate, permissions }: ConnectorDetailContentProps) => {
    const actions = useConnectorActions({
      authMethod: authMethod ?? null,
      data,
      editor,
      mutate,
      permissions,
    });

    return editor.draft ? (
      <ConnectorDetailView
        actionError={editor.actionError}
        busyAction={actions.busyAction}
        conflict={editor.conflict}
        draft={editor.draft}
        permissions={permissions}
        primaryAction={actions.primaryAction}
        saveState={editor.saveState}
        secret={editor.secret}
        snapshot={data}
        validation={editor.validation}
        onArchive={actions.archive}
        onChange={editor.updateDraft}
        onDeleteDraft={actions.deleteDraft}
        onDiscardConflict={editor.discardLocal}
        onDiscover={actions.discover}
        onPrimaryAction={actions.onPrimaryAction}
        onRefreshConflict={() => void mutate()}
        onRevokeBindings={actions.revokeBindings}
        onRollback={actions.rollback}
        onSecretChange={editor.changeSecret}
        onSecretClear={editor.clearSecret}
        onSecretKeep={editor.keepSecret}
        onToolChange={editor.updateTool}
      />
    ) : null;
  },
);

ConnectorDetailContent.displayName = 'AdminConnectorDetailContent';

const ConnectorDetailPage = memo(() => {
  const { id } = useParams<{ id: string }>();
  const { authMethod, permissions } = useAdminAccess();
  const connectorPermissions = deriveAdminConnectorPermissions(permissions);
  const { data, error, isLoading, mutate } = useFetchAdminConnector(
    id,
    Boolean(id && connectorPermissions.canRead),
  );
  const editor = useConnectorEditor(data, connectorPermissions.canUpdate);

  return (
    <AsyncBoundary
      data={data}
      error={error}
      errorVariant={'page'}
      isLoading={isLoading}
      loading={<Loading debugId={'AdminConnectorDetail'} />}
      onRetry={() => void mutate()}
    >
      {data ? (
        <ConnectorDetailContent
          authMethod={authMethod}
          data={data}
          editor={editor}
          mutate={mutate}
          permissions={connectorPermissions}
        />
      ) : null}
    </AsyncBoundary>
  );
});

ConnectorDetailPage.displayName = 'AdminConnectorDetailPage';

export default ConnectorDetailPage;
