'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import type { AdminTableChangeMeta } from '../../primitives/DataTable';
import { getDefaultAuditTimeWindow } from '../shared/timeWindow';
import { useCursorPagination } from '../shared/useCursorPagination';
import { endOfDay, firstFilterValue, parseIsoDay, sameCalendarDay, startOfDay } from './dayFilters';
import { TIMELINE_PAGE_SIZE } from './UserTimelinePane';

/**
 * Evidence window (day range + title query) for one user's conversations, plus the two cursor
 * paginations it drives. Every filter change rewinds the list — a cursor from the previous
 * window would page through the wrong evidence.
 */
export const useConversationUserFilters = (userId: string) => {
  const window0 = useMemo(() => getDefaultAuditTimeWindow(), []);
  const [from, setFrom] = useState(window0.from);
  const [to, setTo] = useState(window0.to);
  const [q, setQ] = useState('');
  const {
    currentCursor,
    hasPrevious,
    limit,
    onNext,
    onPageSizeChange,
    onPrevious,
    reset: resetCursor,
  } = useCursorPagination();
  const {
    currentCursor: timelineCursor,
    hasPrevious: timelineHasPrevious,
    limit: timelineLimit,
    onNext: onTimelineNext,
    onPrevious: onTimelinePrevious,
    reset: resetTimeline,
  } = useCursorPagination({ initialLimit: TIMELINE_PAGE_SIZE });

  const applyTitleQuery = useCallback(
    (next: string) => {
      const trimmed = next.trim();
      if (trimmed === q) return;
      setQ(trimmed);
      resetCursor();
    },
    [q, resetCursor],
  );

  const applyDateRange = useCallback(
    (range: [Date | null, Date | null] | null) => {
      if (!range?.[0] || !range[1]) {
        const fallback = getDefaultAuditTimeWindow();
        setFrom(fallback.from);
        setTo(fallback.to);
        resetCursor();
        return;
      }
      const nextFrom = startOfDay(range[0]);
      const nextTo = endOfDay(range[1]);
      if (sameCalendarDay(from, nextFrom) && sameCalendarDay(to, nextTo)) return;
      setFrom(nextFrom);
      setTo(nextTo);
      resetCursor();
    },
    [from, resetCursor, to],
  );

  const handleTableChange = useCallback(
    ({ filters }: AdminTableChangeMeta) => {
      if (Object.hasOwn(filters, 'title')) {
        applyTitleQuery(firstFilterValue(filters.title) ?? '');
      }

      if (!Object.hasOwn(filters, 'updatedAt')) return;
      const rawRange = filters.updatedAt;
      if (!rawRange || (Array.isArray(rawRange) && !rawRange[0] && !rawRange[1])) {
        applyDateRange(null);
        return;
      }
      const nextFrom = parseIsoDay(rawRange[0]);
      const nextTo = parseIsoDay(rawRange[1]);
      if (!nextFrom || !nextTo) return;
      applyDateRange([nextFrom, nextTo]);
    },
    [applyDateRange, applyTitleQuery],
  );

  // Reset timeline pagination when the evidence window or subject changes.
  useEffect(() => {
    resetTimeline();
  }, [from, resetTimeline, to, userId]);

  return {
    applyDateRange,
    applyTitleQuery,
    from,
    handleTableChange,
    listCursor: {
      currentCursor,
      hasPrevious,
      limit,
      onNext,
      onPageSizeChange,
      onPrevious,
    },
    q,
    /** Both feeds must rewind together when the redaction authority tightens. */
    resetPagination: () => {
      resetCursor();
      resetTimeline();
    },
    timelineCursor: {
      currentCursor: timelineCursor,
      hasPrevious: timelineHasPrevious,
      limit: timelineLimit,
      onNext: onTimelineNext,
      onPrevious: onTimelinePrevious,
    },
    to,
  };
};
