'use client';

import dayjs from 'dayjs';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  type AdminTimeRange,
  type AdminTimeRangeKey,
  formatCustomRangeLabel,
  isAdminTimeRangeDay,
  resolveAdminTimeRange,
} from '../../primitives/timeRange.utils';

const PRESET_LABEL_KEY = {
  '24h': 'timeRange.preset.24h',
  '30d': 'timeRange.preset.30d',
  '7d': 'timeRange.preset.7d',
  '90d': 'timeRange.preset.90d',
  'custom': 'timeRange.preset.custom',
  'today': 'timeRange.preset.today',
} as const satisfies Record<AdminTimeRangeKey, string>;

const DAY_FORMAT = 'YYYY-MM-DD';

/** Moderation dashboards default to the last 7 days (design §6.1). */
export const MODERATION_DEFAULT_RANGE_KEY: AdminTimeRangeKey = '7d';

export interface ModerationTimeRangeControls {
  customFrom?: string;
  customTo?: string;
  range: AdminTimeRange;
  rangeKey: AdminTimeRangeKey;
  setCustomRange: (from?: string, to?: string) => void;
  setRangeKey: (key: AdminTimeRangeKey) => void;
}

/**
 * Local (non-URL) time-range state for the 概况 tab.
 *
 * The shared `useAdminTimeRange` owns `?range=&from=&to=` and defaults to 30 days; the
 * moderation page needs a 7-day default and keeps `?tab=`/`?userId=` for deep links, so it
 * drives the same presentational `TimeRangeFilter` from component state instead.
 * `now` is frozen per selection — a moving upper bound would rewrite the SWR key on every render.
 */
export const useModerationTimeRange = (): ModerationTimeRangeControls => {
  const { t } = useTranslation('admin');
  const [state, setState] = useState<{
    from?: string;
    key: AdminTimeRangeKey;
    nowMs: number;
    to?: string;
  }>(() => ({ key: MODERATION_DEFAULT_RANGE_KEY, nowMs: Date.now() }));

  const bounds = useMemo(
    () =>
      resolveAdminTimeRange(state.key, new Date(state.nowMs), {
        from: state.from,
        to: state.to,
      }),
    [state],
  );

  const range = useMemo<AdminTimeRange>(
    () => ({
      ...bounds,
      label:
        bounds.key === 'custom' ? formatCustomRangeLabel(bounds) : t(PRESET_LABEL_KEY[bounds.key]),
    }),
    [bounds, t],
  );

  const setRangeKey = useCallback(
    (key: AdminTimeRangeKey) => {
      if (key !== 'custom') {
        setState({ key, nowMs: Date.now() });
        return;
      }
      // Seed the picker with the window already on screen: an empty custom window resolves
      // straight back to the default preset, so the control would look like it did nothing.
      setState((prev) => ({
        from: prev.from ?? dayjs(bounds.startAt).format(DAY_FORMAT),
        key: 'custom',
        nowMs: Date.now(),
        to: prev.to ?? dayjs(bounds.endAt).subtract(1, 'millisecond').format(DAY_FORMAT),
      }));
    },
    [bounds.endAt, bounds.startAt],
  );

  const setCustomRange = useCallback((from?: string, to?: string) => {
    setState({
      from: isAdminTimeRangeDay(from) ? from : undefined,
      key: 'custom',
      nowMs: Date.now(),
      to: isAdminTimeRangeDay(to) ? to : undefined,
    });
  }, []);

  return {
    customFrom: state.from,
    customTo: state.to,
    range,
    rangeKey: bounds.key,
    setCustomRange,
    setRangeKey,
  };
};

/** IANA zone for the hourly-bucket query; falls back to UTC in exotic runtimes. */
export const resolveBrowserTimezone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};
