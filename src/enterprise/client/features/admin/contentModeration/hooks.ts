'use client';

import { mutate, useClientDataSWR } from '@/libs/swr';
import type {
  ContentModerationRecordListInput,
  ContentModerationStatsInput,
} from '@/types/platform/contentModeration';

import { adminContentModerationService } from './service';
import {
  buildOverviewKey,
  buildRecordKey,
  buildRecordsKey,
  buildSettingsKey,
  buildStatsKey,
  MODERATION_OVERVIEW_KEY,
  MODERATION_RECORD_KEY,
  MODERATION_RECORDS_KEY,
  MODERATION_STATS_KEY,
} from './swrKeys';

const service = adminContentModerationService;

export const useModerationSettings = (enabled: boolean) =>
  useClientDataSWR(buildSettingsKey(enabled), () => service.getSettings(), {
    revalidateOnFocus: false,
  });

export const useModerationOverview = (enabled: boolean) =>
  useClientDataSWR(buildOverviewKey(enabled), () => service.getOverview(), {
    keepPreviousData: true,
    revalidateOnFocus: false,
  });

export const useModerationStats = (enabled: boolean, input: ContentModerationStatsInput) =>
  useClientDataSWR(buildStatsKey(enabled, input), () => service.getStats(input), {
    keepPreviousData: true,
    revalidateOnFocus: false,
  });

export const useModerationRecords = (enabled: boolean, input: ContentModerationRecordListInput) =>
  useClientDataSWR(buildRecordsKey(enabled, input), () => service.listRecords(input), {
    keepPreviousData: true,
    revalidateOnFocus: false,
  });

export const useModerationRecord = (enabled: boolean, id: string | null) =>
  useClientDataSWR(buildRecordKey(enabled, id), () => service.getRecord({ id: id! }), {
    revalidateOnFocus: false,
  });

/** Records changed (deleted / revealed) — refresh list, detail, stats and the overview counters. */
export const invalidateModerationRecords = () =>
  mutate(
    (key) =>
      Array.isArray(key) &&
      (key[0] === MODERATION_RECORDS_KEY ||
        key[0] === MODERATION_RECORD_KEY ||
        key[0] === MODERATION_STATS_KEY),
  );

export const invalidateModerationOverview = () =>
  mutate((key) => Array.isArray(key) && key[0] === MODERATION_OVERVIEW_KEY);
