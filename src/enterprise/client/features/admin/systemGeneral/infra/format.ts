'use client';

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

export interface InfraValueFormatters {
  /** `—` for null, the value otherwise. */
  unset: (value: number | string | null) => string;
  /** Yes / No / `—`. */
  yesNo: (value: boolean | null) => string;
}

/** Shared read-only value rendering for the 基础设施 cards. */
export const useInfraValueFormatters = (): InfraValueFormatters => {
  const { t } = useTranslation('admin');

  return useMemo(
    () => ({
      unset: (value) => (value === null ? t('systemGeneral.values.unset') : String(value)),
      yesNo: (value) =>
        value === null
          ? t('systemGeneral.values.unset')
          : t(value ? 'systemGeneral.values.yes' : 'systemGeneral.values.no'),
    }),
    [t],
  );
};
