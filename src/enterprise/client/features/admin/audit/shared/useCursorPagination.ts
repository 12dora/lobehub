'use client';

import { type Dispatch, type SetStateAction, useCallback, useMemo, useState } from 'react';

import { ADMIN_POLL_INTERVALS } from '@/enterprise/client/shared/pollIntervals';

export const AUDIT_DEFAULT_LIST_LIMIT = 50;
export const AUDIT_LIST_POLL_MS = ADMIN_POLL_INTERVALS.auditList;

export type AuditInFlightStatus = string | null | undefined;

/** SWR `refreshInterval` helper: poll while any item is pending/running. */
export const pollWhileInFlight =
  <Item extends { status?: AuditInFlightStatus }>(pollMs: number = AUDIT_LIST_POLL_MS) =>
  (latest: { items?: Item[] } | undefined): number =>
    latest?.items?.some((item) => item.status === 'pending' || item.status === 'running')
      ? pollMs
      : 0;

export interface UseCursorPaginationOptions {
  initialLimit?: number;
}

export interface CursorPaginationControls {
  currentCursor: string | null;
  cursorStack: (string | null)[];
  hasPrevious: boolean;
  limit: number;
  onNext: (nextCursor: string | null | undefined) => void;
  onPageSizeChange: (size: number) => void;
  onPrevious: () => void;
  reset: () => void;
  setCursorStack: Dispatch<SetStateAction<(string | null)[]>>;
  setLimit: Dispatch<SetStateAction<number>>;
}

/**
 * Shared cursor-stack + page-size state for admin audit list pages.
 * `onNext` only advances when a non-empty next cursor is provided.
 */
export const useCursorPagination = (
  options: UseCursorPaginationOptions = {},
): CursorPaginationControls => {
  const initialLimit = options.initialLimit ?? AUDIT_DEFAULT_LIST_LIMIT;
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([]);
  const [limit, setLimit] = useState(initialLimit);

  const currentCursor = cursorStack.at(-1) ?? null;
  const hasPrevious = cursorStack.length > 0;

  const onNext = useCallback((nextCursor: string | null | undefined) => {
    if (!nextCursor) return;
    setCursorStack((prev) => [...prev, nextCursor]);
  }, []);

  const onPrevious = useCallback(() => {
    setCursorStack((prev) => prev.slice(0, -1));
  }, []);

  const onPageSizeChange = useCallback((size: number) => {
    setLimit(size);
    setCursorStack([]);
  }, []);

  const reset = useCallback(() => {
    setCursorStack([]);
  }, []);

  return useMemo(
    () => ({
      currentCursor,
      cursorStack,
      hasPrevious,
      limit,
      onNext,
      onPageSizeChange,
      onPrevious,
      reset,
      setCursorStack,
      setLimit,
    }),
    [currentCursor, cursorStack, hasPrevious, limit, onNext, onPageSizeChange, onPrevious, reset],
  );
};
