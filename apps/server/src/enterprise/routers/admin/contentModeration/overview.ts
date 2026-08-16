import { MODERATION_CATEGORIES, MODERATION_LIMITS } from '@/const/platform/contentModeration';
import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import type { LobeChatDatabase } from '@/database/type';
import type {
  ContentModerationConfig,
  ContentModerationOverview,
  ContentModerationOverviewWarning,
} from '@/types/platform/contentModeration';

import { throwEnterpriseError } from '../../../guards/enterpriseErrors';
import { invalidateModerationSnapshot } from '../../../services/contentModeration/settingsSnapshot';

export const STATS_MAX_RANGE_MS = 400 * 24 * 60 * 60 * 1000;
export const STATS_HOUR_BUCKET_MS = 3 * 24 * 60 * 60 * 1000;
export const RECORDS_DELETE_MAX = MODERATION_LIMITS.RECORDS_DELETE_MAX;

/** Log only a finite code and error class — never exception text or secrets. */
export const logModerationFailure = (scope: string, error: unknown, code: string): void => {
  console.error(`[admin.contentModeration] ${scope}`, {
    code,
    errorClass: error instanceof Error ? error.name : 'UnknownError',
  });
};

export const collectOverviewWarnings = (params: {
  clientFetchBypass: boolean;
  config: ContentModerationConfig;
}): ContentModerationOverviewWarning[] => {
  const warnings: ContentModerationOverviewWarning[] = [];
  if (params.clientFetchBypass) warnings.push('client_fetch_bypass');

  const hasDowngradeAction = MODERATION_CATEGORIES.some(
    (category) => params.config.categories[category].action === 'downgrade',
  );
  if (hasDowngradeAction && params.config.downgrade === null) {
    warnings.push('downgrade_not_configured');
  }

  const enabledKeywordCount = params.config.keywords.filter((rule) => rule.enabled).length;
  if (
    params.config.mode !== 'off' &&
    params.config.classifier.kind === 'none' &&
    enabledKeywordCount === 0
  ) {
    warnings.push('classifier_not_configured');
  }

  return warnings;
};

export const classifierLabel = (config: ContentModerationConfig): string | undefined => {
  if (config.classifier.kind === 'llm_judge' && config.classifier.llmJudge) {
    return `${config.classifier.llmJudge.provider}/${config.classifier.llmJudge.model}`;
  }
  if (config.classifier.kind === 'moderations_api' && config.classifier.moderationsApi) {
    return config.classifier.moderationsApi.model || config.classifier.moderationsApi.baseUrl;
  }
  return undefined;
};

export const invalidateModerationSettingsCache = (db?: LobeChatDatabase): void => {
  invalidateModerationSnapshot(db);
};

export const statsBucketForRange = (from: Date, to: Date): 'hour' | 'day' =>
  to.getTime() - from.getTime() <= STATS_HOUR_BUCKET_MS ? 'hour' : 'day';

export const assertStatsRange = (from: Date, to: Date): void => {
  const span = to.getTime() - from.getTime();
  if (span < 0) {
    throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
      details: { field: 'to', reason: 'range_inverted' },
    });
  }
  if (span > STATS_MAX_RANGE_MS) {
    throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
      details: { field: 'to', reason: 'range_too_long' },
    });
  }
};

export const assertStatsTimeZone = (timeZone: string): void => {
  const supported = new Set([...Intl.supportedValuesOf('timeZone'), 'UTC']);
  if (supported.has(timeZone)) return;
  throwEnterpriseError({
    code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
    details: { field: 'timezone', reason: 'unknown_timezone' },
  });
};

export const buildOverview = (params: {
  cacheCount: number;
  clientFetchBypass: boolean;
  config: ContentModerationConfig;
  health: ContentModerationOverview['classifier']['health'];
  updatedAt: Date | null;
}): ContentModerationOverview => ({
  autoBan: {
    enabled: params.config.autoBan.enabled,
    threshold: params.config.autoBan.threshold,
    windowDays: params.config.autoBan.windowDays,
  },
  classifier: {
    health: params.health,
    kind: params.config.classifier.kind,
    label: classifierLabel(params.config),
  },
  decisionCacheCount: params.cacheCount,
  downgrade: params.config.downgrade,
  keywordRuleCount: params.config.keywords.filter((rule) => rule.enabled).length,
  mode: params.config.mode,
  updatedAt: params.updatedAt,
  warnings: collectOverviewWarnings({
    clientFetchBypass: params.clientFetchBypass,
    config: params.config,
  }),
});
