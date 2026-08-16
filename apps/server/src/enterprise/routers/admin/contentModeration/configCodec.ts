import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import type { PlatformSecretService } from '@/server/enterprise/security/secret';
import type {
  ContentModerationConfig,
  ContentModerationSettingsUpdateConfig,
  ContentModerationSettingsView,
} from '@/types/platform/contentModeration';
import { contentModerationConfigSchema } from '@/types/platform/contentModeration';

import { throwEnterpriseError } from '../../../guards/enterpriseErrors';
import type { MaskedModerationApiKey } from './apiKeys';
import {
  assertCombinedApiKeyBound,
  assertRetainedKeysBoundToPersistedEndpoint,
  resolveApiKeyRefs,
} from './apiKeys';

const CONFIG_SECTIONS = [
  'autoBan',
  'categories',
  'classifier',
  'decisionCache',
  'downgrade',
  'keywords',
  'messages',
  'mode',
  'notify',
  'records',
  'requestKinds',
  'scope',
] as const;

export type ContentModerationConfigSection = (typeof CONFIG_SECTIONS)[number];

export interface SettingsDiffSummary {
  apiKeyCount: number;
  changedSections: ContentModerationConfigSection[];
  keywordCount: number;
}

export const storedRefsOf = (config: ContentModerationConfig): string[] =>
  config.classifier.moderationsApi?.apiKeyRefs ?? [];

export const toSettingsView = (params: {
  apiKeys: readonly MaskedModerationApiKey[];
  config: ContentModerationConfig;
  revision: number;
  updatedAt: Date;
  updatedBy: string | null;
}): ContentModerationSettingsView => {
  const { classifier, ...rest } = params.config;
  const { moderationsApi, ...classifierRest } = classifier;
  return {
    ...rest,
    classifier: {
      ...classifierRest,
      llmJudge: classifier.llmJudge,
      moderationsApi: moderationsApi
        ? {
            apiKeys: [...params.apiKeys],
            baseUrl: moderationsApi.baseUrl,
            model: moderationsApi.model,
          }
        : undefined,
    },
    revision: params.revision,
    updatedAt: params.updatedAt,
    updatedBy: params.updatedBy,
  };
};

export const parsePersistedConfig = (config: ContentModerationConfig): ContentModerationConfig => {
  const parsed = contentModerationConfigSchema.safeParse(config);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throwEnterpriseError({
    code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
    details: {
      field: issue?.path.join('.') || 'config',
      reason: 'persisted_config_invalid',
    },
  });
  return config;
};

export const toPersistedConfig = async (params: {
  persistedBaseUrl?: string;
  secretService: PlatformSecretService | null;
  storedRefs: readonly string[];
  update: ContentModerationSettingsUpdateConfig;
}): Promise<ContentModerationConfig> => {
  const { classifier, ...rest } = params.update;
  const { moderationsApi, ...classifierRest } = classifier;

  if (!moderationsApi) {
    return parsePersistedConfig({
      ...rest,
      classifier: {
        ...classifierRest,
        llmJudge: classifier.llmJudge,
      },
    });
  }

  assertCombinedApiKeyBound(moderationsApi.apiKeys.keep, moderationsApi.apiKeys.add);
  assertRetainedKeysBoundToPersistedEndpoint({
    keep: moderationsApi.apiKeys.keep,
    persistedBaseUrl: params.persistedBaseUrl,
    submittedBaseUrl: moderationsApi.baseUrl,
  });

  const apiKeyRefs = await resolveApiKeyRefs({
    add: moderationsApi.apiKeys.add,
    keep: moderationsApi.apiKeys.keep,
    secretService: params.secretService,
    storedRefs: params.storedRefs,
  });

  return parsePersistedConfig({
    ...rest,
    classifier: {
      ...classifierRest,
      llmJudge: classifier.llmJudge,
      moderationsApi: {
        apiKeyRefs,
        baseUrl: moderationsApi.baseUrl,
        model: moderationsApi.model,
      },
    },
  });
};

const jsonStable = (value: unknown): string => JSON.stringify(value);

export const summarizeSettingsDiff = (params: {
  next: ContentModerationConfig;
  previous: ContentModerationConfig | null;
}): SettingsDiffSummary => {
  const previous = params.previous;
  const changedSections = CONFIG_SECTIONS.filter((section) => {
    if (!previous) return true;
    if (section === 'classifier') {
      const before = previous.classifier;
      const after = params.next.classifier;
      return (
        before.kind !== after.kind ||
        before.onError !== after.onError ||
        before.retryCount !== after.retryCount ||
        before.timeoutMs !== after.timeoutMs ||
        jsonStable(before.llmJudge) !== jsonStable(after.llmJudge) ||
        before.moderationsApi?.baseUrl !== after.moderationsApi?.baseUrl ||
        before.moderationsApi?.model !== after.moderationsApi?.model ||
        (before.moderationsApi?.apiKeyRefs.length ?? 0) !==
          (after.moderationsApi?.apiKeyRefs.length ?? 0)
      );
    }
    return jsonStable(previous[section]) !== jsonStable(params.next[section]);
  });

  return {
    apiKeyCount: params.next.classifier.moderationsApi?.apiKeyRefs.length ?? 0,
    changedSections,
    keywordCount: params.next.keywords.length,
  };
};

export const resolveDryRunConfig = (params: {
  override?: ContentModerationSettingsUpdateConfig;
  persisted: ContentModerationConfig;
}): ContentModerationSettingsUpdateConfig => {
  if (params.override) return params.override;
  const { classifier, ...rest } = params.persisted;
  const { moderationsApi, ...classifierRest } = classifier;
  return {
    ...rest,
    classifier: {
      ...classifierRest,
      llmJudge: classifier.llmJudge,
      moderationsApi: moderationsApi
        ? {
            apiKeys: { add: [], keep: [] },
            baseUrl: moderationsApi.baseUrl,
            model: moderationsApi.model,
          }
        : undefined,
    },
  };
};
