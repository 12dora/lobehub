'use client';

import type { TFunction } from 'i18next';
import { useMemo } from 'react';

import { auditActionLabel } from '../shared/format';
import { RESULT_VALUES } from './listFilters';

interface FacetBucket {
  count: number;
  value: string;
}

export interface FacetOptionsArgs {
  facets: { actions?: FacetBucket[]; results?: FacetBucket[] } | undefined;
  /** Actions already selected, so a filter never disappears when its bucket falls out of range. */
  selectedActions: string[];
  t: TFunction<'admin'>;
}

/** Column filter options for action and result, labelled with their counts in the current window. */
export const useFacetOptions = ({ facets, selectedActions, t }: FacetOptionsArgs) => {
  const actionOptions = useMemo(() => {
    const fromFacets = (facets?.actions ?? []).map((item) => ({
      label: `${auditActionLabel(t, item.value)} (${item.count})`,
      value: item.value,
    }));
    for (const action of selectedActions) {
      if (!fromFacets.some((option) => option.value === action)) {
        fromFacets.push({ label: auditActionLabel(t, action), value: action });
      }
    }
    return fromFacets;
  }, [facets?.actions, selectedActions, t]);

  const resultOptions = useMemo(() => {
    const counts = new Map((facets?.results ?? []).map((item) => [item.value, item.count]));
    return RESULT_VALUES.map((value) => ({
      label: counts.has(value)
        ? `${t(`audit.status.result.${value}`)} (${counts.get(value)})`
        : t(`audit.status.result.${value}`),
      value,
    }));
  }, [facets?.results, t]);

  return { actionOptions, resultOptions };
};
