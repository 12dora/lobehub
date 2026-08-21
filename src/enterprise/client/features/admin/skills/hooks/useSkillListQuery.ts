'use client';

import type { FilterValue } from 'antd/es/table/interface';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';

import type { AdminTableChangeMeta } from '../../primitives/DataTable';
import { DEFAULT_PAGE_SIZE } from '../../primitives/dataTableChange';
import type { AdminSkillListInput } from '../types';

const DEFAULT_LIMIT = DEFAULT_PAGE_SIZE;
const SEARCH_DEBOUNCE_MS = 300;

const firstFilterValue = (value: FilterValue | null | undefined): string | undefined => {
  const first = Array.isArray(value) ? value[0] : value;
  if (first === undefined || first === null || first === '') return undefined;
  return String(first);
};

const valueFrom = <Value extends string>(
  value: string | null,
  allowed: readonly Value[],
): Value | undefined => (allowed.includes(value as Value) ? (value as Value) : undefined);

export const useSkillListQuery = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get('q') ?? '';
  const normalizedQuery = query.trim();
  const status = valueFrom(searchParams.get('status'), ['draft', 'published', 'archived']);
  // Admin list is DB-backed only (all production creates use source:'uploaded').
  // Built-in bundled skills are merged at runtime by the read service, not this list.
  const source = valueFrom(searchParams.get('source'), ['uploaded'] as const);
  const distribution = valueFrom(searchParams.get('distribution'), [
    'mandatory',
    'default',
    'optional',
  ]);
  const enabledParam = searchParams.get('enabled');
  const enabled = enabledParam === 'true' ? true : enabledParam === 'false' ? false : undefined;
  const filterFingerprint = JSON.stringify([
    normalizedQuery,
    status ?? '',
    source ?? '',
    distribution ?? '',
    enabledParam === 'true' || enabledParam === 'false' ? enabledParam : '',
  ]);
  const [queryDraft, setQueryDraft] = useState(query);
  const [cursorState, setCursorState] = useState<{
    fingerprint: string;
    stack: (string | null)[];
  }>(() => ({ fingerprint: filterFingerprint, stack: [] }));
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const searchTimerRef = useRef<number | null>(null);
  const cursorStack = cursorState.fingerprint === filterFingerprint ? cursorState.stack : [];
  const cursor = cursorStack.at(-1) ?? null;
  const input = useMemo<AdminSkillListInput>(
    () => ({
      cursor: cursor ?? undefined,
      distribution,
      enabled,
      limit,
      query: normalizedQuery || undefined,
      source,
      status,
    }),
    [cursor, distribution, enabled, limit, normalizedQuery, source, status],
  );

  const patchFilter = useCallback(
    (key: 'distribution' | 'enabled' | 'q' | 'source' | 'status', value?: string) => {
      const next = new URLSearchParams(searchParams);
      if (value) next.set(key, value);
      else next.delete(key);
      setSearchParams(next, { replace: true });
      setCursorState({ fingerprint: '', stack: [] });
    },
    [searchParams, setSearchParams],
  );

  useEffect(() => setQueryDraft(query), [query]);
  useEffect(() => {
    if (cursorState.fingerprint === filterFingerprint) return;
    setCursorState({ fingerprint: filterFingerprint, stack: [] });
  }, [cursorState.fingerprint, filterFingerprint]);
  useEffect(() => {
    if (searchTimerRef.current) window.clearTimeout(searchTimerRef.current);
    if (queryDraft === query) return;
    searchTimerRef.current = window.setTimeout(
      () => patchFilter('q', queryDraft.trim() || undefined),
      SEARCH_DEBOUNCE_MS,
    );
    return () => {
      if (searchTimerRef.current) window.clearTimeout(searchTimerRef.current);
    };
  }, [patchFilter, query, queryDraft]);

  const handleTableChange = useCallback(
    ({ filters }: AdminTableChangeMeta) => {
      const next = new URLSearchParams(searchParams);
      let changed = false;
      const assign = (key: 'distribution' | 'enabled' | 'status') => {
        if (!(key in filters)) return;
        const value = firstFilterValue(filters[key]);
        const current = next.get(key) ?? undefined;
        if (value === current) return;
        if (value) next.set(key, value);
        else next.delete(key);
        changed = true;
      };
      assign('status');
      assign('distribution');
      assign('enabled');
      if (!changed) return;
      setSearchParams(next, { replace: true });
      setCursorState({ fingerprint: '', stack: [] });
    },
    [searchParams, setSearchParams],
  );

  const filtered = Boolean(
    normalizedQuery ||
    status ||
    source ||
    distribution ||
    enabledParam === 'true' ||
    enabledParam === 'false',
  );

  const onNext = (nextCursor: string | null | undefined, isLoading: boolean) => {
    if (!nextCursor || isLoading) return;
    // Idempotent: ignore double-click while the next cursor is already active.
    if (cursorStack.at(-1) === nextCursor) return;
    setCursorState({
      fingerprint: filterFingerprint,
      stack: [...cursorStack, nextCursor],
    });
  };

  const onPageSizeChange = (pageSize: number) => {
    setLimit(pageSize);
    setCursorState({ fingerprint: filterFingerprint, stack: [] });
  };

  const onPrevious = (isLoading: boolean) => {
    if (isLoading) return;
    setCursorState({ fingerprint: filterFingerprint, stack: cursorStack.slice(0, -1) });
  };

  return {
    cursorStack,
    distribution,
    enabledParam,
    filterFingerprint,
    filtered,
    handleTableChange,
    input,
    limit,
    onNext,
    onPageSizeChange,
    onPrevious,
    queryDraft,
    setQueryDraft,
    status,
  };
};
