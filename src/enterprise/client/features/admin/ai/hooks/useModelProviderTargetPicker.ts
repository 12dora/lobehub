'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { buildModelCreateTargetListInput } from '../controller';
import type {
  AdminAiModelCreateTargetListInput,
  AdminAiModelCreateTargetListOutput,
} from '../types';

const SEARCH_DEBOUNCE_MS = 300;
const TARGET_PAGE_LIMIT = 20;

export interface UseModelProviderTargetPickerParams {
  loadTargets: (
    input: AdminAiModelCreateTargetListInput,
  ) => Promise<AdminAiModelCreateTargetListOutput>;
  onSubmit: (providerId: string) => Promise<void>;
}

export const useModelProviderTargetPicker = ({
  loadTargets,
  onSubmit,
}: UseModelProviderTargetPickerParams) => {
  const [query, setQuery] = useState('');
  const [committedQuery, setCommittedQuery] = useState('');
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [items, setItems] = useState<AdminAiModelCreateTargetListOutput['items']>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitFailed, setSubmitFailed] = useState(false);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const requestGenerationRef = useRef(0);
  const cursor = cursorStack.at(-1);
  const isSearchPending = query.trim() !== committedQuery;

  useEffect(() => {
    const normalizedQuery = query.trim();
    if (normalizedQuery === committedQuery) return;

    const timer = window.setTimeout(() => {
      setCommittedQuery(normalizedQuery);
      setCursorStack([]);
      setSelectedProviderId(null);
      setSubmitFailed(false);
    }, SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [committedQuery, query]);

  useEffect(() => {
    const generation = ++requestGenerationRef.current;
    setIsLoading(true);
    setLoadFailed(false);

    void loadTargets(
      buildModelCreateTargetListInput({
        cursor,
        limit: TARGET_PAGE_LIMIT,
        query: committedQuery,
      }),
    )
      .then((result) => {
        if (requestGenerationRef.current !== generation) return;
        setItems(result.items);
        setNextCursor(result.nextCursor);
        setSelectedProviderId((current) =>
          result.items.some((item) => item.id === current) ? current : null,
        );
      })
      .catch(() => {
        if (requestGenerationRef.current !== generation) return;
        setLoadFailed(true);
      })
      .finally(() => {
        if (requestGenerationRef.current === generation) setIsLoading(false);
      });

    return () => {
      if (requestGenerationRef.current === generation) requestGenerationRef.current += 1;
    };
  }, [committedQuery, cursor, loadTargets, retryGeneration]);

  const selectProvider = useCallback((providerId: string) => {
    setSelectedProviderId(providerId);
    setSubmitFailed(false);
  }, []);

  const goToNextPage = useCallback(() => {
    if (!nextCursor) return;
    setCursorStack((current) => [...current, nextCursor]);
    setSelectedProviderId(null);
    setSubmitFailed(false);
  }, [nextCursor]);

  const goToPreviousPage = useCallback(() => {
    setCursorStack((current) => current.slice(0, -1));
    setSelectedProviderId(null);
    setSubmitFailed(false);
  }, []);

  const retryLoad = useCallback(() => {
    setRetryGeneration((current) => current + 1);
  }, []);

  const submit = useCallback(async () => {
    if (!selectedProviderId || isSubmitting) return false;

    setIsSubmitting(true);
    setSubmitFailed(false);
    try {
      await onSubmit(selectedProviderId);
      return true;
    } catch {
      setSubmitFailed(true);
      return false;
    } finally {
      setIsSubmitting(false);
    }
  }, [isSubmitting, onSubmit, selectedProviderId]);

  return {
    canGoNext: Boolean(nextCursor),
    canGoPrevious: cursorStack.length > 0,
    goToNextPage,
    goToPreviousPage,
    isLoading,
    isSearchPending,
    isSubmitting,
    items,
    loadFailed,
    page: cursorStack.length + 1,
    query,
    retryLoad,
    selectProvider,
    selectedProviderId,
    setQuery,
    submit,
    submitFailed,
  };
};
