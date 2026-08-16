import type {
  ContentModerationRecordListInput,
  ContentModerationStatsInput,
} from '@/types/platform/contentModeration';

export const MODERATION_SETTINGS_KEY = 'admin.contentModeration.getSettings';
export const MODERATION_OVERVIEW_KEY = 'admin.contentModeration.getOverview';
export const MODERATION_STATS_KEY = 'admin.contentModeration.getStats';
export const MODERATION_RECORDS_KEY = 'admin.contentModeration.listRecords';
export const MODERATION_RECORD_KEY = 'admin.contentModeration.getRecord';

/** `null` disables the query — SWR never fires for an admin without MODERATION_READ. */
export const buildSettingsKey = (enabled: boolean) =>
  enabled ? ([MODERATION_SETTINGS_KEY] as const) : null;

export const buildOverviewKey = (enabled: boolean) =>
  enabled ? ([MODERATION_OVERVIEW_KEY] as const) : null;

export const buildStatsKey = (enabled: boolean, input: ContentModerationStatsInput) =>
  enabled
    ? ([
        MODERATION_STATS_KEY,
        input.from instanceof Date ? input.from.toISOString() : String(input.from),
        input.to instanceof Date ? input.to.toISOString() : String(input.to),
        input.timezone,
      ] as const)
    : null;

export const buildRecordsKey = (enabled: boolean, input: ContentModerationRecordListInput) =>
  enabled ? ([MODERATION_RECORDS_KEY, JSON.stringify(input)] as const) : null;

export const buildRecordKey = (enabled: boolean, id: string | null) =>
  enabled && id ? ([MODERATION_RECORD_KEY, id] as const) : null;
