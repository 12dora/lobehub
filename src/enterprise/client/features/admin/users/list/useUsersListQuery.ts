'use client';

import type { FilterValue } from 'antd/es/table/interface';
import dayjs from 'dayjs';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { firstColumnFilterValue } from '../../primitives/columnFilters';
import type { AdminTableChangeMeta } from '../../primitives/DataTable';
import { useFetchAdminUsersList } from '../hooks/useAdminUsers';

type AdminUserSource = 'local' | 'sso';
type AdminUserStatus = 'active' | 'banned';

const DEFAULT_LIST_LIMIT = 20;
const DEBOUNCE_MS = 300;

export interface ListQueryState {
  createdFrom?: Date;
  createdTo?: Date;
  page: number;
  pageSize: number;
  query: string;
  role?: string;
  source?: AdminUserSource;
  status?: AdminUserStatus;
}

const emptyQuery = (): ListQueryState => ({
  page: 1,
  pageSize: DEFAULT_LIST_LIMIT,
  query: '',
});

const parseStatus = (value: FilterValue | null | undefined): AdminUserStatus | undefined => {
  const next = firstColumnFilterValue(value);
  return next === 'active' || next === 'banned' ? next : undefined;
};

const parseSource = (value: FilterValue | null | undefined): AdminUserSource | undefined => {
  const next = firstColumnFilterValue(value);
  return next === 'local' || next === 'sso' ? next : undefined;
};

export const useUsersListQuery = () => {
  const [queryState, setQueryState] = useState<ListQueryState>(emptyQuery);
  const [searchDraft, setSearchDraft] = useState('');
  const debounceRef = useRef<number | null>(null);

  const { createdFrom, createdTo, page, pageSize, query, role, source, status } = queryState;

  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      const nextQuery = searchDraft.trim();
      setQueryState((prev) => {
        if (prev.query === nextQuery) return prev;
        return { ...prev, page: 1, query: nextQuery };
      });
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [searchDraft]);

  const listFilters = useMemo(
    () => ({
      createdFrom,
      createdTo,
      limit: pageSize,
      offset: (page - 1) * pageSize,
      query: query || undefined,
      role,
      source,
      status,
    }),
    [createdFrom, createdTo, page, pageSize, query, role, source, status],
  );

  const { data, error, isLoading, isValidating, mutate } = useFetchAdminUsersList(listFilters);

  // Jump back when offset is past the current total (deleted last page, stale jumper).
  useEffect(() => {
    if (!data) return;
    const lastPage = Math.max(1, Math.ceil(data.total / pageSize) || 1);
    if (page <= lastPage) return;
    setQueryState((prev) => {
      const nextLast = Math.max(1, Math.ceil(data.total / prev.pageSize) || 1);
      if (prev.page <= nextLast) return prev;
      return { ...prev, page: nextLast };
    });
  }, [data, page, pageSize]);

  const createdRange = useMemo<[Date | null, Date | null] | null>(() => {
    if (!createdFrom && !createdTo) return null;
    return [createdFrom ?? null, createdTo ?? null];
  }, [createdFrom, createdTo]);

  const handleCreatedRange = useCallback((value: [Date | null, Date | null] | null) => {
    const from = value?.[0] ? dayjs(value[0]).startOf('day').toDate() : undefined;
    const to = value?.[1] ? dayjs(value[1]).endOf('day').toDate() : undefined;
    setQueryState((prev) => ({
      ...prev,
      createdFrom: from,
      createdTo: to,
      page: 1,
    }));
  }, []);

  const handleTableChange = useCallback(({ filters }: AdminTableChangeMeta) => {
    const nextStatus = parseStatus(filters.status);
    const nextRole = firstColumnFilterValue(filters.roles);
    const nextSource = parseSource(filters.source);
    setQueryState((prev) => {
      const filtersChanged =
        nextStatus !== prev.status || nextRole !== prev.role || nextSource !== prev.source;
      if (
        !filtersChanged &&
        nextStatus === prev.status &&
        nextRole === prev.role &&
        nextSource === prev.source
      ) {
        return prev;
      }
      return {
        ...prev,
        page: filtersChanged ? 1 : prev.page,
        role: nextRole,
        source: nextSource,
        status: nextStatus,
      };
    });
  }, []);

  const handlePaginationChange = useCallback((nextPage: number, nextPageSize: number) => {
    setQueryState((prev) => ({
      ...prev,
      page: nextPage,
      pageSize: nextPageSize,
    }));
  }, []);

  return {
    createdRange,
    data,
    error,
    handleCreatedRange,
    handlePaginationChange,
    handleTableChange,
    isLoading,
    isValidating,
    listFilters,
    mutate,
    queryState,
    searchDraft,
    setQueryState,
    setSearchDraft,
  };
};
