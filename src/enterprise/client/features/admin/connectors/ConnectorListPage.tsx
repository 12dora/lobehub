'use client';

import { toast } from '@lobehub/ui/base-ui';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
/** Match the admin skill catalog debounce so typing does not thrash URL/SWR. */
export const CONNECTOR_SEARCH_DEBOUNCE_MS = 300;

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
  const query = searchParams.get('q') ?? '';
  const normalizedQuery = query.trim();
  const status = enumValue(searchParams.get('status'), ['draft', 'published', 'archived']);
  const credentialMode = enumValue(searchParams.get('credentialMode'), [
    'none',
    'shared_service_account',
    'per_user_oauth',
  ]);
  const enabledParam = searchParams.get('enabled');
  const enabled = enabledParam === 'true' ? true : enabledParam === 'false' ? false : undefined;
  const fingerprint = JSON.stringify([
    normalizedQuery,
    status ?? '',
    credentialMode ?? '',
    enabledParam,
  ]);
  const [queryDraft, setQueryDraft] = useState(query);
  const [cursorState, setCursorState] = useState<{ fingerprint: string; stack: (string | null)[] }>(
    { fingerprint, stack: [] },
  );
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const searchTimerRef = useRef<number | null>(null);
  const cursorStack = cursorState.fingerprint === fingerprint ? cursorState.stack : [];
  const cursor = cursorStack.at(-1) ?? null;
  const input = useMemo<AdminConnectorListInput>(
    () => ({
      credentialMode,
      cursor: cursor ?? undefined,
      enabled,
      limit,
      query: normalizedQuery || undefined,
      status,
    }),
    [credentialMode, cursor, enabled, limit, normalizedQuery, status],
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

  useEffect(() => setQueryDraft(query), [query]);
  useEffect(() => {
    if (cursorState.fingerprint === fingerprint) return;
    setCursorState({ fingerprint, stack: [] });
  }, [cursorState.fingerprint, fingerprint]);
  useEffect(() => {
    if (searchTimerRef.current) window.clearTimeout(searchTimerRef.current);
    if (queryDraft === query) return;
    searchTimerRef.current = window.setTimeout(
      () => patchFilter('query', queryDraft.trim() || undefined),
      CONNECTOR_SEARCH_DEBOUNCE_MS,
    );
    return () => {
      if (searchTimerRef.current) window.clearTimeout(searchTimerRef.current);
    };
  }, [patchFilter, query, queryDraft]);

  const onFilterChange = useCallback(
    (key: 'credentialMode' | 'enabled' | 'query' | 'status', value?: string) => {
      if (key === 'query') {
        setQueryDraft(value ?? '');
        return;
      }
      patchFilter(key, value);
    },
    [patchFilter],
  );

  const onColumnFiltersChange = useCallback(
    (next: { credentialMode?: string; enabled?: string; status?: string }) => {
      const params = new URLSearchParams(searchParams);
      let changed = false;
      const assign = (key: 'credentialMode' | 'enabled' | 'status') => {
        if (!(key in next)) return;
        const value = next[key];
        const current = params.get(key) ?? undefined;
        if (value === current) return;
        if (value) params.set(key, value);
        else params.delete(key);
        changed = true;
      };
      assign('credentialMode');
      assign('enabled');
      assign('status');
      if (!changed) return;
      setSearchParams(params, { replace: true });
      setCursorState({ fingerprint: '', stack: [] });
    },
    [searchParams, setSearchParams],
  );

  return (
    <ConnectorListView
      data={data?.items}
      error={Boolean(error)}
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
      filters={{
        credentialMode,
        enabled,
        query: queryDraft || undefined,
        status,
      }}
      onColumnFiltersChange={onColumnFiltersChange}
      onFilterChange={onFilterChange}
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
