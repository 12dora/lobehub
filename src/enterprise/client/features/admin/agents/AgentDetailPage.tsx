'use client';

import { memo } from 'react';
import { useParams } from 'react-router';

import AsyncBoundary from '@/components/AsyncBoundary';
import Loading from '@/components/Loading/BrandTextLoading';
import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import { useEnterprisePlatform } from '@/enterprise/client/providers/EnterprisePlatformProvider';
import { adminAgentsService } from '@/enterprise/client/services/adminAgents';

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
  const { authMethod, permissions } = useAdminAccess();
  const { capabilities } = useEnterprisePlatform();
  const agentPermissions = deriveAdminAgentPermissions(permissions);
  const rolloutsEnabled = capabilities.managedResources.agents;
  const { data, error, isLoading, mutate, retryRolloutPoll, rolloutPollError } = useFetchAdminAgent(
    id,
    Boolean(id && agentPermissions.canRead),
    adminAgentsService,
    rolloutsEnabled,
  );
  // Never surface retained/stale detail for a different route identity.
  const matchedData = data && id && data.identity.id === id ? data : undefined;
  const editor = useAgentEditor(matchedData, agentPermissions.canUpdate);
  // Withhold the view until the editor has hydrated for THIS route agent. Otherwise a B snapshot
  // can paint one frame with A's still-mounted draftBaseline/draft (A→B navigation race).
  const editorMatchesRoute = Boolean(id && editor.draftBaseline?.agentId === id);
  const readyData = matchedData && editorMatchesRoute ? matchedData : undefined;

  if (isNotFoundError(error)) return <AdminNotFoundSurface />;

  return (
    <AsyncBoundary
      data={readyData}
      // Do not suppress the current key's error with a previous agent's data.
      error={readyData ? undefined : error}
      errorVariant="page"
      isLoading={isLoading || Boolean(matchedData && !editorMatchesRoute)}
      loading={<Loading debugId="AdminAgentDetail" />}
      onRetry={() => void mutate()}
    >
      {readyData ? (
        <AgentDetailView
          authMethod={authMethod ?? null}
          editor={editor}
          mutate={mutate}
          permissions={agentPermissions}
          pollError={rolloutPollError}
          retryRolloutPoll={retryRolloutPoll}
          rolloutsEnabled={rolloutsEnabled}
          snapshot={readyData}
        />
      ) : null}
    </AsyncBoundary>
  );
});

AgentDetailPage.displayName = 'AgentDetailPage';

export default AgentDetailPage;
