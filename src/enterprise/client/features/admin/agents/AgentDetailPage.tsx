'use client';

import { memo } from 'react';
import { useParams } from 'react-router';

import AsyncBoundary from '@/components/AsyncBoundary';
import Loading from '@/components/Loading/BrandTextLoading';
import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';

import { AdminNotFoundSurface } from '../pages/AdminStateSurfaces';
import { AgentDetailView } from './AgentDetailView';
import { deriveAdminAgentPermissions } from './controller';
import { useFetchAdminAgent } from './useAdminAgents';
import { useAgentEditor } from './useAgentEditor';

const isNotFoundError = (error: unknown) => {
  if (!error) return false;
  if (mapEnterpriseError(error)?.code === 'PLATFORM_NOT_FOUND') return true;
  const message = String((error as { message?: unknown }).message ?? '');
  const dataCode = String((error as { data?: { code?: unknown } }).data?.code ?? '');
  return message.includes('PLATFORM_NOT_FOUND') || dataCode === 'PLATFORM_NOT_FOUND';
};

const AgentDetailPage = memo(() => {
  const { id } = useParams<{ id: string }>();
  const { permissions } = useAdminAccess();
  const agentPermissions = deriveAdminAgentPermissions(permissions);
  const { data, error, isLoading, mutate } = useFetchAdminAgent(
    id,
    Boolean(id && agentPermissions.canRead),
  );
  const editor = useAgentEditor(data, agentPermissions.canUpdate);

  if (isNotFoundError(error)) return <AdminNotFoundSurface />;

  return (
    <AsyncBoundary
      data={data}
      error={error}
      errorVariant="page"
      isLoading={isLoading}
      loading={<Loading debugId="AdminAgentDetail" />}
      onRetry={() => void mutate()}
    >
      {data ? (
        <AgentDetailView
          editor={editor}
          permissions={agentPermissions}
          refresh={mutate}
          snapshot={data}
        />
      ) : null}
    </AsyncBoundary>
  );
});

AgentDetailPage.displayName = 'AgentDetailPage';

export default AgentDetailPage;
