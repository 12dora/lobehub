'use client';

import { useCallback, useEffect, useState } from 'react';
import useSWR from 'swr';

import { fileService } from '@/services/file';
import { type DocumentPreviewResult } from '@/types/files/render';

/** How often we ask the server again while the conversion is running. */
export const DOCUMENT_PREVIEW_POLL_INTERVAL = 2000;

/** After this long in `pending` we stop polling and let the user decide. */
export const DOCUMENT_PREVIEW_POLL_TIMEOUT = 90 * 1000;

/**
 * Poll only while the server says the conversion is still running, and only
 * until we gave up waiting — so an abandoned tab never polls forever.
 */
/** The presigned PDF URL lives ~15 min; fetch a fresh one before it expires. */
export const DOCUMENT_PREVIEW_READY_REFRESH_INTERVAL = 10 * 60 * 1000;

export const getPreviewRefreshInterval = (
  data: DocumentPreviewResult | undefined,
  timedOut: boolean,
): number => {
  if (data?.status === 'pending') return timedOut ? 0 : DOCUMENT_PREVIEW_POLL_INTERVAL;
  if (data?.status === 'ready') return DOCUMENT_PREVIEW_READY_REFRESH_INTERVAL;
  return 0;
};

export interface UseDocumentPreviewReturn {
  data?: DocumentPreviewResult;
  error?: unknown;
  isLoading: boolean;
  /** Ask again right now (also restarts the give-up timer). */
  retry: () => void;
  /** We waited long enough without a result. */
  timedOut: boolean;
}

export const useDocumentPreview = (fileId: string): UseDocumentPreviewReturn => {
  const [timedOut, setTimedOut] = useState(false);
  const [pendingSince, setPendingSince] = useState<number | null>(null);

  const { data, error, isLoading, mutate } = useSWR<DocumentPreviewResult>(
    ['file-document-preview', fileId],
    () => fileService.getDocumentPreview(fileId),
    {
      dedupingInterval: 1000,
      refreshInterval: (latest) => getPreviewRefreshInterval(latest, timedOut),
      revalidateOnFocus: false,
    },
  );

  const status = data?.status;

  useEffect(() => {
    if (status !== 'pending') {
      setPendingSince(null);
      setTimedOut(false);
      return;
    }

    if (pendingSince === null) {
      setPendingSince(Date.now());
      return;
    }

    const remaining = DOCUMENT_PREVIEW_POLL_TIMEOUT - (Date.now() - pendingSince);
    if (remaining <= 0) {
      setTimedOut(true);
      return;
    }

    const timer = setTimeout(() => setTimedOut(true), remaining);
    return () => clearTimeout(timer);
  }, [status, pendingSince]);

  const retry = useCallback(() => {
    setTimedOut(false);
    setPendingSince(Date.now());
    void mutate();
  }, [mutate]);

  return { data, error, isLoading, retry, timedOut };
};
