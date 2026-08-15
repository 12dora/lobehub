'use client';

import { Select } from '@lobehub/ui/base-ui';
import { DatePicker } from 'antd';
import dayjs from 'dayjs';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import {
  ADMIN_TIME_RANGE_KEYS,
  type AdminTimeRange,
  type AdminTimeRangeKey,
  DEFAULT_ADMIN_TIME_RANGE_KEY,
  formatCustomRangeLabel,
  isAdminTimeRangeDay,
  resolveAdminTimeRange,
} from './timeRange.utils';

const PRESET_LABEL_KEY = {
  '24h': 'timeRange.preset.24h',
  '30d': 'timeRange.preset.30d',
  '7d': 'timeRange.preset.7d',
  '90d': 'timeRange.preset.90d',
  'custom': 'timeRange.preset.custom',
  'today': 'timeRange.preset.today',
} as const satisfies Record<AdminTimeRangeKey, string>;

const DAY_FORMAT = 'YYYY-MM-DD';

export interface AdminTimeRangeControls {
  customFrom?: string;
  customTo?: string;
  range: AdminTimeRange;
  /** Effective key — never `custom` unless the custom window is actually usable. */
  rangeKey: AdminTimeRangeKey;
  setCustomRange: (from?: string, to?: string) => void;
  setRangeKey: (key: AdminTimeRangeKey) => void;
}

const isRangeKey = (value: string | null): value is AdminTimeRangeKey =>
  value !== null && (ADMIN_TIME_RANGE_KEYS as readonly string[]).includes(value);

/**
 * URL-backed admin time-range state (`?range=&from=&to=`).
 *
 * `now` is frozen per selection instead of being re-read on every render: a
 * moving upper bound would rewrite every SWR key on each render and refetch the
 * whole dashboard in a loop. Picking a preset re-stamps it.
 *
 * The URL is *canonicalized*: whatever it says, the control and the queries agree.
 * A custom window that cannot be honoured (missing / impossible / inverted days —
 * e.g. a hand-edited `?range=custom&from=2026-02-31`) resolves to the default preset,
 * and the dead `range` / `from` / `to` params are dropped instead of leaving the Select
 * on 自定义 with an empty picker over a 30-day query.
 *
 * Writes go through `useSearchParams` rather than three `useQueryParam`s because the
 * three params must move in ONE history entry: an intermediate `range=custom` without
 * days would be observable and would be canonicalized away before the days landed.
 */
export const useAdminTimeRange = (): AdminTimeRangeControls => {
  const { t } = useTranslation('admin');
  const [searchParams, setSearchParams] = useSearchParams();

  const rawKey = searchParams.get('range');
  const rawFrom = searchParams.get('from');
  const rawTo = searchParams.get('to');

  const requestedKey = isRangeKey(rawKey) ? rawKey : DEFAULT_ADMIN_TIME_RANGE_KEY;
  const customFrom = isAdminTimeRangeDay(rawFrom) ? rawFrom : undefined;
  const customTo = isAdminTimeRangeDay(rawTo) ? rawTo : undefined;

  const [nowMs, setNowMs] = useState(() => Date.now());

  const bounds = useMemo(
    () => resolveAdminTimeRange(requestedKey, new Date(nowMs), { from: customFrom, to: customTo }),
    [requestedKey, customFrom, customTo, nowMs],
  );
  // What the page actually queries — the Select must show this, not the raw URL value.
  const rangeKey = bounds.key;

  const range = useMemo<AdminTimeRange>(
    () => ({
      ...bounds,
      label:
        bounds.key === 'custom' ? formatCustomRangeLabel(bounds) : t(PRESET_LABEL_KEY[bounds.key]),
    }),
    [bounds, t],
  );

  /** Rewrite the three params as one statement; the default preset clears `range`. */
  const writeParams = useCallback(
    (next: { from?: string | null; range: AdminTimeRangeKey; to?: string | null }) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          const apply = (key: string, value?: string | null) => {
            if (value) params.set(key, value);
            else params.delete(key);
          };
          apply('range', next.range === DEFAULT_ADMIN_TIME_RANGE_KEY ? null : next.range);
          apply('from', next.from);
          apply('to', next.to);
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const canonicalKey = rangeKey === DEFAULT_ADMIN_TIME_RANGE_KEY ? null : rangeKey;
  const canonicalFrom = rangeKey === 'custom' ? (customFrom ?? null) : null;
  const canonicalTo = rangeKey === 'custom' ? (customTo ?? null) : null;

  useEffect(() => {
    if (rawKey === canonicalKey && rawFrom === canonicalFrom && rawTo === canonicalTo) return;
    writeParams({ from: canonicalFrom, range: rangeKey, to: canonicalTo });
  }, [rawKey, rawFrom, rawTo, canonicalKey, canonicalFrom, canonicalTo, rangeKey, writeParams]);

  const setRangeKey = useCallback(
    (key: AdminTimeRangeKey) => {
      setNowMs(Date.now());
      if (key !== 'custom') {
        writeParams({ from: null, range: key, to: null });
        return;
      }
      // Seed the picker with the window already on screen: an empty custom window is
      // unusable, so it would be canonicalized straight back to the default preset.
      writeParams({
        from: dayjs(bounds.startAt).format(DAY_FORMAT),
        range: 'custom',
        to: dayjs(bounds.endAt).subtract(1, 'millisecond').format(DAY_FORMAT),
      });
    },
    [bounds.endAt, bounds.startAt, writeParams],
  );

  const setCustomRange = useCallback(
    (from?: string, to?: string) => {
      setNowMs(Date.now());
      // Clearing the picker leaves an unusable window — canonicalization then puts both
      // the control and the URL back on the default preset.
      writeParams({ from: from ?? null, range: 'custom', to: to ?? null });
    },
    [writeParams],
  );

  return { customFrom, customTo, range, rangeKey, setCustomRange, setRangeKey };
};

export interface TimeRangeFilterProps extends Pick<
  AdminTimeRangeControls,
  'customFrom' | 'customTo' | 'rangeKey' | 'setCustomRange' | 'setRangeKey'
> {}

/**
 * Quick-pick time range for admin dashboards. Presets cover the common windows;
 * `custom` reveals a day RangePicker (antd — neither base-ui nor `@lobehub/ui`
 * ships a range picker).
 */
const TimeRangeFilter = memo<TimeRangeFilterProps>(
  ({ customFrom, customTo, rangeKey, setCustomRange, setRangeKey }) => {
    const { t } = useTranslation('admin');

    const options = useMemo(
      () =>
        ADMIN_TIME_RANGE_KEYS.map((key) => ({
          label: t(PRESET_LABEL_KEY[key]),
          value: key,
        })),
      [t],
    );

    return (
      <>
        <Select
          aria-label={t('timeRange.label')}
          options={options}
          style={{ width: 160 }}
          value={rangeKey}
          onChange={(value) => setRangeKey((value as AdminTimeRangeKey) ?? rangeKey)}
        />
        {rangeKey === 'custom' ? (
          <DatePicker.RangePicker
            allowClear
            aria-label={t('timeRange.customAria')}
            disabledDate={(current) => Boolean(current) && current.isAfter(dayjs(), 'day')}
            placeholder={[t('timeRange.from'), t('timeRange.to')]}
            style={{ flex: '0 0 auto', width: 250 }}
            value={[customFrom ? dayjs(customFrom) : null, customTo ? dayjs(customTo) : null]}
            onChange={(value) =>
              setCustomRange(
                value?.[0] ? dayjs(value[0]).format(DAY_FORMAT) : undefined,
                value?.[1] ? dayjs(value[1]).format(DAY_FORMAT) : undefined,
              )
            }
          />
        ) : null}
      </>
    );
  },
);

TimeRangeFilter.displayName = 'AdminTimeRangeFilter';

export default TimeRangeFilter;
