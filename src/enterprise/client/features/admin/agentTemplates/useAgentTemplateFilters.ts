'use client';

import type { FilterValue } from 'antd/es/table/interface';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import type { AdminTableChangeMeta } from '../primitives/DataTable';
import type { AdminAgentTemplateListQuery } from './types';

const DEFAULT_PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 300;

const firstFilterValue = (value: FilterValue | null | undefined): string | undefined => {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw == null || raw === '') return undefined;
  return String(raw);
};

export const useAgentTemplateFilters = () => {
  const { i18n } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();

  // The list resolves the bundled-library preview rows in the console language, the same way
  // the import action does — so the operator previews exactly the copy an import would write.
  const locale = i18n.resolvedLanguage || i18n.language;

  const query = searchParams.get('q') ?? '';
  const normalizedQuery = query.trim();
  const enabledParam = searchParams.get('enabled');
  const enabled = enabledParam === 'true' ? true : enabledParam === 'false' ? false : undefined;

  const [queryDraft, setQueryDraft] = useState(query);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const searchTimerRef = useRef<number | null>(null);

  const input = useMemo<AdminAgentTemplateListQuery>(
    () => ({
      enabled,
      limit: pageSize,
      locale,
      offset: (page - 1) * pageSize,
      query: normalizedQuery || undefined,
    }),
    [enabled, locale, normalizedQuery, page, pageSize],
  );

  const filtered = Boolean(normalizedQuery || enabled !== undefined);

  const patchFilter = useCallback(
    (key: 'enabled' | 'q', value?: string) => {
      const next = new URLSearchParams(searchParams);
      if (value) next.set(key, value);
      else next.delete(key);
      setSearchParams(next, { replace: true });
      setPage(1);
    },
    [searchParams, setSearchParams],
  );

  const handleTableChange = useCallback(
    ({ filters }: AdminTableChangeMeta) => {
      if (!Object.hasOwn(filters, 'enabled')) return;
      const next = firstFilterValue(filters.enabled);
      const enabledValue = next === 'true' || next === 'false' ? next : undefined;
      const current =
        enabledParam === 'true' || enabledParam === 'false' ? enabledParam : undefined;
      if (enabledValue !== current) patchFilter('enabled', enabledValue);
    },
    [enabledParam, patchFilter],
  );

  useEffect(() => setQueryDraft(query), [query]);
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

  return {
    enabledParam,
    filtered,
    handleTableChange,
    input,
    page,
    pageSize,
    queryDraft,
    setPage,
    setPageSize,
    setQueryDraft,
  };
};
