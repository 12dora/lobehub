'use client';

import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { describeInterval, EM_DASH } from './format';

/**
 * Localized "every N minutes / hours / days".
 *
 * Kept as a hook (rather than a helper taking `t`) so a caller cannot accidentally render the
 * unit from the wrong namespace, and so the unit names go through i18n like every other string.
 */
export const useFormatInterval = () => {
  const { t } = useTranslation('admin');
  return useCallback(
    (seconds: number | null | undefined): string => {
      const described = describeInterval(seconds);
      if (!described) return EM_DASH;
      return t(`networkProxy.units.${described.unit}` as never, { count: described.value });
    },
    [t],
  );
};
