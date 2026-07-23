'use client';

import { toast } from '@lobehub/ui/base-ui';
import { memo, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router';

import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import { adminConnectorsService } from '@/enterprise/client/services/adminConnectors';

import ConnectorListView from './ConnectorListView';
import { deriveAdminConnectorPermissions } from './controller';
import { openCreateConnectorModal } from './openCreateConnectorModal';
import type { AdminConnectorListInput } from './types';
import { refreshAdminConnectorLists, useFetchAdminConnectors } from './useAdminConnectorCatalog';

const DEFAULT_LIMIT = 50;

const enumValue = <Value extends string>(
  value: string | null,
  allowed: readonly Value[],
): Value | undefined => (allowed.includes(value as Value) ? (value as Value) : undefined);

const ConnectorListPage = memo(() => {
  const navigate = useNavigate();
  const { t } = useTranslation('admin');
  const { authMethod, permissions } = useAdminAccess();
  const connectorPermissions = deriveAdminConnectorPermissions(permissions);
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get('q')?.trim() || undefined;
  const status = enumValue(searchParams.get('status'), ['draft', 'published', 'archived']);
  const credentialMode = enumValue(searchParams.get('credentialMode'), [
    'none',
    'shared_service_account',
    'per_user_oauth',
  ]);
  const enabledParam = searchParams.get('enabled');
  const enabled = enabledParam === 'true' ? true : enabledParam === 'false' ? false : undefined;
  const fingerprint = JSON.stringify([
    query ?? '',
    status ?? '',
    credentialMode ?? '',
    enabledParam,
  ]);
  const [cursorState, setCursorState] = useState<{ fingerprint: string; stack: (string | null)[] }>(
    { fingerprint, stack: [] },
  );
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const cursorStack = cursorState.fingerprint === fingerprint ? cursorState.stack : [];
  const cursor = cursorStack.at(-1) ?? null;
  const input = useMemo<AdminConnectorListInput>(
    () => ({
      credentialMode,
      cursor: cursor ?? undefined,
      enabled,
      limit,
      query,
      status,
    }),
    [credentialMode, cursor, enabled, limit, query, status],
  );
  const { data, error, isLoading, mutate } = useFetchAdminConnectors(
    input,
    connectorPermissions.canRead,
  );

  const patchFilter = useCallback(
    (key: 'credentialMode' | 'enabled' | 'query' | 'status', value?: string) => {
      const next = new URLSearchParams(searchParams);
      const urlKey = key === 'query' ? 'q' : key;
      if (value) next.set(urlKey, value);
      else next.delete(urlKey);
      setSearchParams(next, { replace: true });
      setCursorState({ fingerprint: '', stack: [] });
    },
    [searchParams, setSearchParams],
  );

  return (
    <ConnectorListView
      data={data?.items}
      error={Boolean(error)}
      filters={{ credentialMode, enabled, query, status }}
      loading={isLoading}
      permissions={connectorPermissions}
      cursorPagination={{
        hasNext: Boolean(data?.nextCursor),
        hasPrevious: cursorStack.length > 0,
        onNext: () => {
          if (data?.nextCursor) {
            setCursorState({ fingerprint, stack: [...cursorStack, data.nextCursor] });
          }
        },
        onPageSizeChange: (pageSize) => {
          setLimit(pageSize);
          setCursorState({ fingerprint, stack: [] });
        },
        onPrevious: () => setCursorState({ fingerprint, stack: cursorStack.slice(0, -1) }),
        pageSize: limit,
      }}
      onFilterChange={patchFilter}
      onOpen={(id) => navigate(`/admin/connectors/${encodeURIComponent(id)}`)}
      onRetry={() => void mutate()}
      onCreate={() =>
        openCreateConnectorModal({
          authMethod: authMethod ?? undefined,
          onSubmit: async (createInput) => {
            const created = await adminConnectorsService.createDraft(createInput);
            await refreshAdminConnectorLists();
            toast.success(t('connectorCatalog.toast.created'));
            navigate(`/admin/connectors/${encodeURIComponent(created.draft.id)}`);
          },
        })
      }
    />
  );
});

ConnectorListPage.displayName = 'AdminConnectorListPage';

export default ConnectorListPage;
