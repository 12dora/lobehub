'use client';

import { toast } from '@lobehub/ui/base-ui';
import type { TFunction } from 'i18next';
import { useEffect, useRef } from 'react';

/**
 * One toast per failure episode of an optional page section, re-armed only once it recovers —
 * a revalidation loop must not bury the auditor under duplicate toasts.
 */
export const useSummaryFailureToast = (failed: boolean, t: TFunction<'admin'>) => {
  const notifiedRef = useRef(false);

  useEffect(() => {
    if (failed && !notifiedRef.current) {
      notifiedRef.current = true;
      toast.error(t('audit.shared.summaryLoadFailed'));
    } else if (!failed) {
      notifiedRef.current = false;
    }
  }, [failed, t]);
};
