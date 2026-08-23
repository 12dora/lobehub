'use client';

import { useCallback, useMemo, useState } from 'react';

import type { AdminTableChangeMeta } from '../../primitives/DataTable';
import { AUDIT_DEFAULT_LIST_LIMIT, useCursorPagination } from '../shared/useCursorPagination';
import {
  type AuditResult,
  emptyFilters,
  firstNonEmpty,
  type ListFilters,
  listFiltersEqual,
  toResultList,
  toStringList,
} from './listFilters';

/**
 * Every filter surface of the operation log writes through here so the cursor rewinds whenever —
 * and only whenever — the query actually changed. Paging on with a stale cursor would silently
 * skip events, which on an audit trail reads as evidence going missing.
 */
export const useOperationLogFilters = () => {
  const [filters, setFilters] = useState<ListFilters>(emptyFilters);
  const {
    currentCursor,
    hasPrevious,
    limit,
    onNext,
    onPageSizeChange,
    onPrevious,
    reset: resetCursor,
    setLimit,
  } = useCursorPagination();

  const applyFilters = useCallback(
    (patch: Partial<ListFilters>) => {
      setFilters((prev) => {
        const next = { ...prev, ...patch };
        if (listFiltersEqual(prev, next)) return prev;
        resetCursor();
        return next;
      });
    },
    [resetCursor],
  );

  const toggleResult = useCallback(
    (result: AuditResult | null) => {
      if (result === null) {
        applyFilters({ results: [] });
        return;
      }
      setFilters((prev) => {
        const has = prev.results.includes(result);
        const next = {
          ...prev,
          results: has ? prev.results.filter((item) => item !== result) : [result],
        };
        if (listFiltersEqual(prev, next)) return prev;
        resetCursor();
        return next;
      });
    },
    [applyFilters, resetCursor],
  );

  const toggleActionFacet = useCallback(
    (action: string) => {
      setFilters((prev) => {
        const has = prev.actions.includes(action);
        const next = {
          ...prev,
          actions: has ? prev.actions.filter((item) => item !== action) : [...prev.actions, action],
        };
        if (listFiltersEqual(prev, next)) return prev;
        resetCursor();
        return next;
      });
    },
    [resetCursor],
  );

  const handleTableChange = useCallback(
    ({ filters: next }: AdminTableChangeMeta) => {
      applyFilters({
        actions: toStringList(next.action),
        actorUserId: firstNonEmpty(next.actorUserId),
        requestId: firstNonEmpty(next.requestId),
        results: toResultList(next.result),
      });
    },
    [applyFilters],
  );

  const clearAllFilters = useCallback(() => {
    setFilters(emptyFilters());
    setLimit(AUDIT_DEFAULT_LIST_LIMIT);
    resetCursor();
  }, [resetCursor, setLimit]);

  const listInput = useMemo(
    () => ({
      actions: filters.actions.length ? filters.actions : undefined,
      actorUserId: filters.actorUserId,
      cursor: currentCursor ?? undefined,
      from: filters.from,
      limit,
      requestId: filters.requestId,
      results: filters.results.length ? filters.results : undefined,
      targetId: filters.targetId,
      targetType: filters.targetType,
      to: filters.to,
    }),
    [currentCursor, filters, limit],
  );

  const activeResult = filters.results.length === 1 ? filters.results[0] : null;
  const hasActiveFilters =
    filters.actions.length > 0 ||
    filters.results.length > 0 ||
    Boolean(filters.actorUserId) ||
    Boolean(filters.requestId) ||
    Boolean(filters.targetId) ||
    Boolean(filters.targetType);

  return {
    activeResult,
    applyFilters,
    clearAllFilters,
    cursor: { hasPrevious, limit, onNext, onPageSizeChange, onPrevious },
    filters,
    handleTableChange,
    hasActiveFilters,
    listInput,
    toggleActionFacet,
    toggleResult,
  };
};
