import { z } from 'zod';

import type {
  ModerationCategory,
  ModerationCategoryAction,
  ModerationClassifierKind,
  ModerationDecisionSource,
  ModerationEffectiveAction,
  ModerationMode,
  ModerationRequestKind,
} from '@/const/platform/contentModeration';

// Value imports must be relative: packages/types vitest does not resolve `@/const/*`.
import {
  MODERATION_CATEGORIES,
  MODERATION_CATEGORY_ACTIONS,
  MODERATION_CLASSIFIER_KINDS,
  MODERATION_DECISION_SOURCES,
  MODERATION_DEFAULT_CATEGORY_POLICY,
  MODERATION_DEFAULTS,
  MODERATION_EFFECTIVE_ACTIONS,
  MODERATION_LIMITS,
  MODERATION_MODES,
  MODERATION_REQUEST_KINDS,
} from '../../../const/src/platform/contentModeration';
import { assessRegexSafety } from './regexSafety';

export type { RegexSafetyResult } from './regexSafety';
export { assessRegexSafety, probeRegexPerformance } from './regexSafety';

export type {
  ModerationCategory,
  ModerationCategoryAction,
  ModerationClassifierKind,
  ModerationDecisionSource,
  ModerationEffectiveAction,
  ModerationMode,
  ModerationRequestKind,
};

const moderationModeSchema = z.enum(MODERATION_MODES);
const moderationCategorySchema = z.enum(MODERATION_CATEGORIES);
const moderationCategoryActionSchema = z.enum(MODERATION_CATEGORY_ACTIONS);
const moderationEffectiveActionSchema = z.enum(MODERATION_EFFECTIVE_ACTIONS);
const moderationDecisionSourceSchema = z.enum(MODERATION_DECISION_SOURCES);
const moderationRequestKindSchema = z.enum(MODERATION_REQUEST_KINDS);
const moderationClassifierKindSchema = z.enum(MODERATION_CLASSIFIER_KINDS);

const compileKeywordRegex = (pattern: string): Error | null => {
  try {
    new RegExp(pattern, 'iu');
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
};

const reportInvalidKeywordRegex = (ctx: z.RefinementCtx, index: number, pattern: string) => {
  const error = compileKeywordRegex(pattern);
  if (error) {
    ctx.addIssue({
      code: 'custom',
      message: `INVALID_KEYWORD_REGEX: keywords[${index}]`,
      path: ['keywords', index, 'pattern'],
    });
    return;
  }
  const safety = assessRegexSafety(pattern);
  if (!safety.ok) {
    ctx.addIssue({
      code: 'custom',
      message: `UNSAFE_KEYWORD_REGEX: keywords[${index}] (${safety.reason})`,
      path: ['keywords', index, 'pattern'],
    });
  }
};

export const keywordRuleSchema = z
  .object({
    action: moderationCategoryActionSchema,
    category: moderationCategorySchema,
    enabled: z.boolean(),
    id: z.string().uuid(),
    isRegex: z.boolean(),
    note: z.string().max(200).optional(),
    pattern: z.string().min(1).max(MODERATION_LIMITS.KEYWORD_MAX_LENGTH),
  })
  .strict();

export type KeywordRule = z.infer<typeof keywordRuleSchema>;

const categoryPolicySchema = z
  .object({
    action: moderationCategoryActionSchema,
    threshold: z.number().min(0).max(1),
  })
  .strict();

const modelFilterSchema = z
  .object({
    models: z.array(z.string().min(1)).max(2000),
    type: z.enum(['all', 'include', 'exclude']),
  })
  .strict();

const scopeSchema = z
  .object({
    exemptRoles: z.array(z.string().min(1)).max(50),
    exemptUserIds: z.array(z.string().min(1)).max(10_000),
    modelFilter: modelFilterSchema,
    sampleRate: z.number().min(0).max(100),
  })
  .strict();

const llmJudgeSchema = z
  .object({
    extraGuidance: z.string().max(4000).optional(),
    model: z.string().min(1),
    provider: z.string().min(1),
  })
  .strict();

const moderationsApiPersistedSchema = z
  .object({
    apiKeyRefs: z.array(z.string().min(1)).max(20),
    baseUrl: z.string().url().max(2048),
    model: z.string().min(1),
  })
  .strict();

const maskedApiKeySchema = z
  .object({
    fingerprint: z.string().min(1),
    masked: z.string().min(1),
  })
  .strict();

const moderationsApiViewSchema = z
  .object({
    apiKeys: z.array(maskedApiKeySchema).max(20),
    baseUrl: z.string().url().max(2048),
    model: z.string().min(1),
  })
  .strict();

const moderationsApiUpdateSchema = z
  .object({
    apiKeys: z
      .object({
        add: z.array(z.string().min(8).max(512)).max(20),
        keep: z.array(z.string().min(1)).max(20),
      })
      .strict(),
    baseUrl: z.string().url().max(2048),
    model: z.string().min(1),
  })
  .strict();

const classifierBaseFields = {
  kind: moderationClassifierKindSchema,
  onError: z.enum(['allow', 'block']),
  retryCount: z.number().int().min(0).max(5),
  timeoutMs: z.number().int().min(500).max(30_000),
};

const refineClassifierKind = <
  T extends {
    kind: ModerationClassifierKind;
    llmJudge?: unknown;
    moderationsApi?: unknown;
  },
>(
  value: T,
  ctx: z.RefinementCtx,
) => {
  if (value.kind === 'llm_judge' && !value.llmJudge) {
    ctx.addIssue({
      code: 'custom',
      message: 'LLM_JUDGE_REQUIRED',
      path: ['classifier', 'llmJudge'],
    });
  }
  if (value.kind === 'moderations_api' && !value.moderationsApi) {
    ctx.addIssue({
      code: 'custom',
      message: 'MODERATIONS_API_REQUIRED',
      path: ['classifier', 'moderationsApi'],
    });
  }
};

const persistedClassifierSchema = z
  .object({
    ...classifierBaseFields,
    llmJudge: llmJudgeSchema.optional(),
    moderationsApi: moderationsApiPersistedSchema.optional(),
  })
  .strict();

const viewClassifierSchema = z
  .object({
    ...classifierBaseFields,
    llmJudge: llmJudgeSchema.optional(),
    moderationsApi: moderationsApiViewSchema.optional(),
  })
  .strict();

const updateClassifierSchema = z
  .object({
    ...classifierBaseFields,
    llmJudge: llmJudgeSchema.optional(),
    moderationsApi: moderationsApiUpdateSchema.optional(),
  })
  .strict();

const decisionCacheSchema = z
  .object({
    enabled: z.boolean(),
    ttlHours: z.number().int().min(0).max(MODERATION_LIMITS.DECISION_CACHE_TTL_MAX_HOURS),
  })
  .strict();

const downgradeTargetSchema = z
  .object({
    model: z.string().min(1),
    provider: z.string().min(1),
  })
  .strict();

const DOWNGRADE_MESSAGE_ENCODED_MAX = 2048;

const messagesSchema = z
  .object({
    blockMessage: z.string().max(2000),
    /** Travels in a response header (`encodeURIComponent`) — keep it short. */
    downgradeMessage: z.string().max(300),
    showCategoryToUser: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (encodeURIComponent(value.downgradeMessage).length > DOWNGRADE_MESSAGE_ENCODED_MAX) {
      ctx.addIssue({
        code: 'custom',
        message: 'DOWNGRADE_MESSAGE_ENCODED_TOO_LONG',
        path: ['downgradeMessage'],
      });
    }
  });

const autoBanSchema = z
  .object({
    durationDays: z.number().int().min(1).max(3650).nullable(),
    enabled: z.boolean(),
    threshold: z.number().int().min(1).max(10_000),
    windowDays: z.number().int().min(1).max(3650),
  })
  .strict();

const recordsSchema = z
  .object({
    hitRetentionDays: z.number().int().min(1).max(MODERATION_LIMITS.HIT_RETENTION_MAX_DAYS),
    nonHitRetentionDays: z.number().int().min(0).max(MODERATION_LIMITS.NON_HIT_RETENTION_MAX_DAYS),
    recordNonHits: z.boolean(),
    storeFullPrompt: z.boolean(),
  })
  .strict();

const notifySchema = z
  .object({
    emails: z.array(z.string().email()).max(20),
    enabled: z.boolean(),
    onActions: z.array(moderationEffectiveActionSchema).max(MODERATION_EFFECTIVE_ACTIONS.length),
  })
  .strict();

const categoriesRecordSchema = z
  .object(
    Object.fromEntries(
      MODERATION_CATEGORIES.map((category) => [category, categoryPolicySchema]),
    ) as Record<ModerationCategory, typeof categoryPolicySchema>,
  )
  .strict();

const refineSharedConfig = (
  value: {
    classifier: { kind: ModerationClassifierKind; llmJudge?: unknown; moderationsApi?: unknown };
    keywords: KeywordRule[];
    records: { nonHitRetentionDays: number };
  },
  ctx: z.RefinementCtx,
) => {
  if (value.keywords.length > MODERATION_LIMITS.KEYWORD_MAX_RULES) {
    ctx.addIssue({
      code: 'custom',
      message: 'TOO_MANY_KEYWORD_RULES',
      path: ['keywords'],
    });
  }
  if (value.records.nonHitRetentionDays > MODERATION_LIMITS.NON_HIT_RETENTION_MAX_DAYS) {
    ctx.addIssue({
      code: 'custom',
      message: 'NON_HIT_RETENTION_TOO_LONG',
      path: ['records', 'nonHitRetentionDays'],
    });
  }
  refineClassifierKind(value.classifier, ctx);
  value.keywords.forEach((rule, index) => {
    if (rule.isRegex) reportInvalidKeywordRegex(ctx, index, rule.pattern);
  });
};

const contentModerationConfigFields = {
  autoBan: autoBanSchema,
  categories: categoriesRecordSchema,
  classifier: persistedClassifierSchema,
  decisionCache: decisionCacheSchema,
  downgrade: downgradeTargetSchema.nullable(),
  keywords: z.array(keywordRuleSchema).max(MODERATION_LIMITS.KEYWORD_MAX_RULES),
  messages: messagesSchema,
  mode: moderationModeSchema,
  notify: notifySchema,
  records: recordsSchema,
  requestKinds: z.array(moderationRequestKindSchema).min(1).max(3),
  scope: scopeSchema,
};

export const contentModerationConfigSchema = z
  .object(contentModerationConfigFields)
  .strict()
  .superRefine(refineSharedConfig);

export type ContentModerationConfig = z.infer<typeof contentModerationConfigSchema>;

/** Empty = client / B2 render localized copy. Persist only when an admin types an override. */
export const DEFAULT_BLOCK_MESSAGE = '';
export const DEFAULT_DOWNGRADE_MESSAGE = '';

const cloneCategoryPolicy = (): ContentModerationConfig['categories'] => {
  const cloned = {} as ContentModerationConfig['categories'];
  for (const category of MODERATION_CATEGORIES) {
    cloned[category] = { ...MODERATION_DEFAULT_CATEGORY_POLICY[category] };
  }
  return cloned;
};

export const createDefaultContentModerationConfig = (): ContentModerationConfig => ({
  autoBan: {
    durationDays: null,
    enabled: false,
    threshold: MODERATION_DEFAULTS.AUTO_BAN_THRESHOLD,
    windowDays: MODERATION_DEFAULTS.AUTO_BAN_WINDOW_DAYS,
  },
  categories: cloneCategoryPolicy(),
  classifier: {
    kind: 'none',
    onError: 'allow',
    retryCount: MODERATION_DEFAULTS.CLASSIFIER_RETRY_COUNT,
    timeoutMs: MODERATION_DEFAULTS.CLASSIFIER_TIMEOUT_MS,
  },
  decisionCache: {
    enabled: true,
    ttlHours: MODERATION_DEFAULTS.DECISION_CACHE_TTL_HOURS,
  },
  downgrade: null,
  keywords: [],
  messages: {
    blockMessage: DEFAULT_BLOCK_MESSAGE,
    downgradeMessage: DEFAULT_DOWNGRADE_MESSAGE,
    showCategoryToUser: true,
  },
  mode: 'off',
  notify: {
    emails: [],
    enabled: false,
    onActions: ['block'],
  },
  records: {
    hitRetentionDays: MODERATION_DEFAULTS.HIT_RETENTION_DAYS,
    nonHitRetentionDays: MODERATION_DEFAULTS.NON_HIT_RETENTION_DAYS,
    recordNonHits: false,
    storeFullPrompt: false,
  },
  requestKinds: [...MODERATION_REQUEST_KINDS],
  scope: {
    exemptRoles: ['super_admin', 'admin'],
    exemptUserIds: [],
    modelFilter: { models: [], type: 'all' },
    sampleRate: MODERATION_DEFAULTS.SAMPLE_RATE,
  },
});

export const contentModerationSettingsViewSchema = z
  .object({
    ...contentModerationConfigFields,
    classifier: viewClassifierSchema,
    revision: z.number().int().min(0),
    updatedAt: z.coerce.date(),
    updatedBy: z.string().nullable(),
  })
  .strict()
  .superRefine(refineSharedConfig);

export type ContentModerationSettingsView = z.infer<typeof contentModerationSettingsViewSchema>;

export const contentModerationSettingsUpdateConfigSchema = z
  .object({
    ...contentModerationConfigFields,
    classifier: updateClassifierSchema,
  })
  .strict()
  .superRefine(refineSharedConfig);

export type ContentModerationSettingsUpdateConfig = z.infer<
  typeof contentModerationSettingsUpdateConfigSchema
>;

export const contentModerationSettingsUpdateInputSchema = z
  .object({
    config: contentModerationSettingsUpdateConfigSchema,
    expectedRevision: z.number().int().min(0),
  })
  .strict();

export type ContentModerationSettingsUpdateInput = z.infer<
  typeof contentModerationSettingsUpdateInputSchema
>;

const userSnapshotSchema = z
  .object({
    email: z.string().nullable().optional(),
    fullName: z.string().nullable().optional(),
    username: z.string().nullable().optional(),
  })
  .strict();

const matchedRuleSchema = z
  .object({
    id: z.string(),
    isRegex: z.boolean(),
    pattern: z.string(),
  })
  .strict();

const categoryScoresSchema = z.record(moderationCategorySchema, z.number());

export const contentModerationRecordSchema = z
  .object({
    autoBanned: z.boolean(),
    categoryScores: categoryScoresSchema,
    classifierLatencyMs: z.number().int().nullable(),
    createdAt: z.coerce.date(),
    effectiveAction: moderationEffectiveActionSchema,
    effectiveModel: z.string().nullable(),
    effectiveProvider: z.string().nullable(),
    enforced: z.boolean(),
    error: z.string().nullable(),
    hasFullPrompt: z.boolean(),
    id: z.string(),
    matchedRule: matchedRuleSchema.nullable(),
    messageId: z.string().nullable(),
    model: z.string(),
    notified: z.boolean(),
    policyAction: moderationCategoryActionSchema,
    promptExcerpt: z.string(),
    promptHash: z.string(),
    provider: z.string(),
    requestId: z.string().nullable(),
    requestKind: moderationRequestKindSchema,
    revealedAt: z.coerce.date().nullable(),
    revealedBy: z.string().nullable(),
    source: moderationDecisionSourceSchema,
    thresholdSnapshot: z.record(moderationCategorySchema, categoryPolicySchema),
    topCategory: moderationCategorySchema.nullable(),
    topScore: z.number().nullable(),
    topicId: z.string().nullable(),
    userId: z.string().nullable(),
    userSnapshot: userSnapshotSchema.nullable(),
    violationCount: z.number().int(),
  })
  .strict();

export type ContentModerationRecord = z.infer<typeof contentModerationRecordSchema>;

export const contentModerationRecordListInputSchema = z
  .object({
    actions: z.array(moderationEffectiveActionSchema).optional(),
    categories: z.array(moderationCategorySchema).optional(),
    from: z.coerce.date().optional(),
    includeNonHits: z.boolean().optional(),
    limit: z.number().int().min(1).max(100),
    offset: z.number().int().min(0),
    policyActions: z.array(moderationCategoryActionSchema).optional(),
    requestKinds: z.array(moderationRequestKindSchema).optional(),
    search: z.string().max(500).optional(),
    sources: z.array(moderationDecisionSourceSchema).optional(),
    to: z.coerce.date().optional(),
    userId: z.string().optional(),
    userQuery: z.string().max(200).optional(),
  })
  .strict();

export type ContentModerationRecordListInput = z.infer<
  typeof contentModerationRecordListInputSchema
>;

export const contentModerationRecordListOutputSchema = z
  .object({
    items: z.array(contentModerationRecordSchema),
    total: z.number().int().min(0),
  })
  .strict();

export type ContentModerationRecordListOutput = z.infer<
  typeof contentModerationRecordListOutputSchema
>;

export const contentModerationStatsInputSchema = z
  .object({
    from: z.coerce.date(),
    timezone: z.string().min(1),
    to: z.coerce.date(),
  })
  .strict();

export type ContentModerationStatsInput = z.infer<typeof contentModerationStatsInputSchema>;

const statsKpiSchema = z
  .object({
    allow: z.number().int(),
    avgLatencyMs: z.number().nullable(),
    block: z.number().int(),
    downgrade: z.number().int(),
    error: z.number().int(),
    log: z.number().int(),
    total: z.number().int(),
    wouldBlock: z.number().int(),
    wouldDowngrade: z.number().int(),
  })
  .strict();

const statsSeriesPointSchema = z
  .object({
    allow: z.number().int(),
    block: z.number().int(),
    bucketStart: z.string(),
    downgrade: z.number().int(),
    error: z.number().int(),
    log: z.number().int(),
  })
  .strict();

export const contentModerationStatsOutputSchema = z
  .object({
    categories: z.array(
      z
        .object({
          category: z.string(),
          count: z.number().int(),
        })
        .strict(),
    ),
    kpi: statsKpiSchema,
    requestKinds: z.array(
      z
        .object({
          count: z.number().int(),
          kind: z.string(),
        })
        .strict(),
    ),
    series: z.array(statsSeriesPointSchema),
    sources: z.array(
      z
        .object({
          count: z.number().int(),
          source: z.string(),
        })
        .strict(),
    ),
    topUsers: z.array(
      z
        .object({
          count: z.number().int(),
          email: z.string().optional(),
          fullName: z.string().optional(),
          userId: z.string(),
          username: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();

export type ContentModerationStatsOutput = z.infer<typeof contentModerationStatsOutputSchema>;

export const CONTENT_MODERATION_OVERVIEW_WARNINGS = [
  'client_fetch_bypass',
  'downgrade_not_configured',
  'classifier_not_configured',
] as const;
export type ContentModerationOverviewWarning =
  (typeof CONTENT_MODERATION_OVERVIEW_WARNINGS)[number];

const classifierHealthSchema = z
  .object({
    avgLatencyMs: z.number(),
    sampleSize: z.number().int(),
    successRate: z.number(),
  })
  .strict();

export const contentModerationOverviewSchema = z
  .object({
    autoBan: z
      .object({
        enabled: z.boolean(),
        threshold: z.number().int(),
        windowDays: z.number().int(),
      })
      .strict(),
    classifier: z
      .object({
        health: classifierHealthSchema.nullable(),
        kind: moderationClassifierKindSchema,
        label: z.string().optional(),
      })
      .strict(),
    decisionCacheCount: z.number().int(),
    downgrade: downgradeTargetSchema.nullable(),
    keywordRuleCount: z.number().int(),
    mode: moderationModeSchema,
    updatedAt: z.coerce.date().nullable(),
    warnings: z.array(z.enum(CONTENT_MODERATION_OVERVIEW_WARNINGS)),
  })
  .strict();

export type ContentModerationOverview = z.infer<typeof contentModerationOverviewSchema>;

export const contentModerationTestClassifierInputSchema = z
  .object({
    config: contentModerationSettingsUpdateConfigSchema.optional(),
    text: z.string().min(1).max(MODERATION_LIMITS.CLASSIFIER_INPUT_MAX_CHARS),
  })
  .strict();

export type ContentModerationTestClassifierInput = z.infer<
  typeof contentModerationTestClassifierInputSchema
>;

export const contentModerationTestClassifierOutputSchema = z
  .object({
    error: z.string().optional(),
    latencyMs: z.number(),
    matchedRule: z
      .object({
        id: z.string(),
        pattern: z.string(),
      })
      .strict()
      .optional(),
    policyAction: moderationCategoryActionSchema,
    scores: categoryScoresSchema,
    source: moderationDecisionSourceSchema,
  })
  .strict();

export type ContentModerationTestClassifierOutput = z.infer<
  typeof contentModerationTestClassifierOutputSchema
>;
