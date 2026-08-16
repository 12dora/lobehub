import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { PlatformContentModerationDecisionModel } from '@/database/models/platform/contentModerationDecisions';
import { PlatformContentModerationHourlyStatsModel } from '@/database/models/platform/contentModerationHourlyStats';
import { PlatformContentModerationRecordModel } from '@/database/models/platform/contentModerationRecords';
import { PlatformContentModerationSettingsModel } from '@/database/models/platform/contentModerationSettings';
import { PlatformRevisionConflictError } from '@/database/models/platform/errors';
import type { LobeChatDatabase } from '@/database/type';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';
import {
  type ContentModerationConfig,
  contentModerationOverviewSchema,
  contentModerationRecordListInputSchema,
  contentModerationRecordListOutputSchema,
  contentModerationRecordSchema,
  contentModerationSettingsUpdateInputSchema,
  contentModerationSettingsViewSchema,
  contentModerationStatsInputSchema,
  contentModerationStatsOutputSchema,
  contentModerationTestClassifierInputSchema,
  contentModerationTestClassifierOutputSchema,
} from '@/types/platform/contentModeration';

import { withActiveUser } from '../../guards/activeUser';
import { withAdminMutationRateLimit } from '../../guards/adminMutationRateLimit';
import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import { withPlatformPermission } from '../../guards/platformPermission';
import {
  CONTENT_MODERATION_AUDIT_ACTIONS,
  CONTENT_MODERATION_AUDIT_TARGET_TYPES,
} from '../../services/contentModeration/constants';
import { obtainPlatformSecretService } from '../../services/contentModeration/secrets';
import { PlatformAuditService } from '../../services/platformAudit';
import {
  assertCombinedApiKeyBound,
  assertKeywordRegexesSafe,
  assertRetainedKeysBoundToPersistedEndpoint,
  assertStatsRange,
  assertStatsTimeZone,
  buildOverview,
  hasPublishedClientFetchBypass,
  invalidateModerationSettingsCache,
  loadPublishedModelCatalog,
  loadRecordUser,
  loadSystemRoles,
  logModerationFailure,
  maskStoredApiKeys,
  RECORDS_DELETE_MAX,
  resolveDryRunConfig,
  resolvePlaintextApiKeys,
  revealRecordPromptAtomic,
  runClassifierDryRun,
  statsBucketForRange,
  storedRefsOf,
  summarizeSettingsDiff,
  toPersistedConfig,
  toSettingsView,
  validateCatalogBoundModels,
} from './contentModerationSupport';

const adminBase = authedProcedure
  .use(serverDatabase)
  .use(withActiveUser())
  .use(withAdminMutationRateLimit());

const moderationRead = adminBase.use(withPlatformPermission(PLATFORM_PERMISSIONS.MODERATION_READ));
const moderationManage = adminBase.use(
  withPlatformPermission(PLATFORM_PERMISSIONS.MODERATION_MANAGE),
);

const publishedCatalogProviderSchema = z
  .object({
    models: z.array(
      z
        .object({
          displayName: z.string(),
          id: z.string(),
        })
        .strict(),
    ),
    provider: z.string(),
    providerName: z.string(),
  })
  .strict();

const getSettingsOutputSchema = z
  .object({
    catalog: z.array(publishedCatalogProviderSchema),
    roles: z.array(
      z
        .object({
          displayName: z.string().optional(),
          name: z.string(),
        })
        .strict(),
    ),
    settings: contentModerationSettingsViewSchema,
  })
  .strict();

const getRecordOutputSchema = contentModerationRecordSchema
  .extend({
    user: z
      .object({
        avatar: z.string().nullable(),
        email: z.string().nullable(),
        fullName: z.string().nullable(),
        username: z.string().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

const idInputSchema = z.object({ id: z.string().min(1) }).strict();

const deleteRecordsInputSchema = z
  .object({
    ids: z.array(z.string().min(1)).min(1).max(RECORDS_DELETE_MAX),
  })
  .strict();

const revealOutputSchema = z
  .object({
    prompt: z.string().nullable(),
  })
  .strict();

const deleteRecordsOutputSchema = z
  .object({
    deleted: z.number().int().min(0),
  })
  .strict();

const clearCacheOutputSchema = z
  .object({
    deleted: z.number().int().min(0),
  })
  .strict();

const mapModerationError = (error: unknown): never => {
  if (error instanceof TRPCError) throw error;
  if (error instanceof PlatformRevisionConflictError) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT,
      details: error.details as Record<string, string | number | boolean | null> | undefined,
    });
  }
  if (error instanceof z.ZodError) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
      details: { issueCount: error.issues.length },
    });
  }
  if (error instanceof Error && error.message === 'Unknown IANA time zone') {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
      details: { field: 'timezone', reason: 'unknown_timezone' },
    });
  }
  if (error instanceof Error && error.message.startsWith('Unknown IANA time zone:')) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
      details: { field: 'timezone', reason: 'unknown_timezone' },
    });
  }
  logModerationFailure('unexpected operation failure', error, 'operation_failed');
  return throwEnterpriseError({
    code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
    details: { reason: 'operation_failed' },
    httpCode: 'INTERNAL_SERVER_ERROR',
  });
};

const settingsViewFor = async (
  db: LobeChatDatabase,
  row: {
    config: ContentModerationConfig;
    revision: number;
    updatedAt: Date;
    updatedBy: string | null;
  },
) => {
  const apiKeys = await maskStoredApiKeys({
    refs: storedRefsOf(row.config),
    secretService: obtainPlatformSecretService(),
  });
  return toSettingsView({
    apiKeys,
    config: row.config,
    revision: row.revision,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  });
};

const getSettingsPayload = async (db: LobeChatDatabase) => {
  const model = new PlatformContentModerationSettingsModel(db);
  const row = await model.ensureDefault();
  const [settings, catalog, roles] = await Promise.all([
    settingsViewFor(db, row),
    loadPublishedModelCatalog(db),
    loadSystemRoles(db),
  ]);
  return { catalog, roles, settings };
};

/**
 * admin.contentModeration.* — platform content-moderation settings, overview, records.
 */
export const adminContentModerationRouter = router({
  clearDecisionCache: moderationManage.output(clearCacheOutputSchema).mutation(async ({ ctx }) => {
    try {
      return await ctx.serverDB.transaction(async (tx) => {
        const deleted = await new PlatformContentModerationDecisionModel(tx).clear();
        await new PlatformAuditService(tx).append({
          action: CONTENT_MODERATION_AUDIT_ACTIONS.CACHE_CLEAR,
          actorUserId: ctx.userId!,
          afterDiff: { deleted },
          result: 'success',
          targetId: 'default',
          targetType: CONTENT_MODERATION_AUDIT_TARGET_TYPES.SETTINGS,
        });
        return { deleted };
      });
    } catch (error) {
      return mapModerationError(error);
    }
  }),

  deleteRecords: moderationManage
    .input(deleteRecordsInputSchema)
    .output(deleteRecordsOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.serverDB.transaction(async (tx) => {
          const deleted = await new PlatformContentModerationRecordModel(tx).deleteByIds(input.ids);
          await new PlatformAuditService(tx).append({
            action: CONTENT_MODERATION_AUDIT_ACTIONS.RECORDS_DELETE,
            actorUserId: ctx.userId!,
            afterDiff: { count: deleted },
            result: 'success',
            targetType: CONTENT_MODERATION_AUDIT_TARGET_TYPES.RECORD,
          });
          return { deleted };
        });
      } catch (error) {
        return mapModerationError(error);
      }
    }),

  getOverview: moderationRead.output(contentModerationOverviewSchema).query(async ({ ctx }) => {
    try {
      const settingsModel = new PlatformContentModerationSettingsModel(ctx.serverDB);
      const row = await settingsModel.ensureDefault();
      const [cacheCount, health, clientFetchBypass] = await Promise.all([
        new PlatformContentModerationDecisionModel(ctx.serverDB).count(),
        new PlatformContentModerationHourlyStatsModel(ctx.serverDB).classifierHealth({
          lastN: 100,
        }),
        hasPublishedClientFetchBypass(ctx.serverDB),
      ]);
      return buildOverview({
        cacheCount,
        clientFetchBypass,
        config: row.config,
        health,
        updatedAt: row.updatedAt,
      });
    } catch (error) {
      return mapModerationError(error);
    }
  }),

  getRecord: moderationRead
    .input(idInputSchema)
    .output(getRecordOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        const record = await new PlatformContentModerationRecordModel(ctx.serverDB).getById(
          input.id,
        );
        if (!record) {
          return throwEnterpriseError({
            code: PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND,
            httpCode: 'NOT_FOUND',
          });
        }
        const user = await loadRecordUser(ctx.serverDB, record.userId);
        return { ...record, user };
      } catch (error) {
        return mapModerationError(error);
      }
    }),

  getSettings: moderationRead.output(getSettingsOutputSchema).query(async ({ ctx }) => {
    try {
      return await getSettingsPayload(ctx.serverDB);
    } catch (error) {
      return mapModerationError(error);
    }
  }),

  getStats: moderationRead
    .input(contentModerationStatsInputSchema)
    .output(contentModerationStatsOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        assertStatsRange(input.from, input.to);
        assertStatsTimeZone(input.timezone);
        const range = { from: input.from, to: input.to };
        const stats = new PlatformContentModerationHourlyStatsModel(ctx.serverDB);
        const records = new PlatformContentModerationRecordModel(ctx.serverDB);
        const [kpi, series, categories, sources, requestKinds, topUsers] = await Promise.all([
          stats.totals(range),
          stats.series({
            ...range,
            bucket: statsBucketForRange(input.from, input.to),
            timezone: input.timezone,
          }),
          stats.byCategory(range),
          stats.bySource(range),
          stats.byRequestKind(range),
          records.topUsers({ ...range, limit: 10 }),
        ]);
        return {
          categories,
          kpi,
          requestKinds,
          series,
          sources,
          topUsers,
        };
      } catch (error) {
        return mapModerationError(error);
      }
    }),

  listRecords: moderationRead
    .input(contentModerationRecordListInputSchema)
    .output(contentModerationRecordListOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await new PlatformContentModerationRecordModel(ctx.serverDB).list(input);
      } catch (error) {
        return mapModerationError(error);
      }
    }),

  revealRecordPrompt: moderationManage
    .input(idInputSchema)
    .output(revealOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.serverDB.transaction(async (tx) => {
          const revealed = await revealRecordPromptAtomic(tx, {
            actorUserId: ctx.userId!,
            id: input.id,
          });
          if (!revealed) {
            return throwEnterpriseError({
              code: PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND,
              httpCode: 'NOT_FOUND',
            });
          }
          await new PlatformAuditService(tx).append({
            action: CONTENT_MODERATION_AUDIT_ACTIONS.RECORD_REVEAL,
            actorUserId: ctx.userId!,
            result: 'success',
            targetId: input.id,
            targetType: CONTENT_MODERATION_AUDIT_TARGET_TYPES.RECORD,
          });
          return revealed;
        });
      } catch (error) {
        return mapModerationError(error);
      }
    }),

  testClassifier: moderationManage
    .input(contentModerationTestClassifierInputSchema)
    .output(contentModerationTestClassifierOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const settings = await new PlatformContentModerationSettingsModel(
          ctx.serverDB,
        ).ensureDefault();
        const config = resolveDryRunConfig({
          override: input.config,
          persisted: settings.config,
        });
        const catalog = await loadPublishedModelCatalog(ctx.serverDB);
        validateCatalogBoundModels({ catalog, config });
        await assertKeywordRegexesSafe({
          next: config.keywords,
          previous: settings.config.keywords,
        });
        const storedRefs = storedRefsOf(settings.config);
        const secretService = obtainPlatformSecretService();
        const keep = input.config
          ? (input.config.classifier.moderationsApi?.apiKeys.keep ?? [])
          : (await maskStoredApiKeys({ refs: storedRefs, secretService })).map(
              (key) => key.fingerprint,
            );
        const add = input.config?.classifier.moderationsApi?.apiKeys.add ?? [];
        assertCombinedApiKeyBound(keep, add);
        assertRetainedKeysBoundToPersistedEndpoint({
          keep,
          persistedBaseUrl: settings.config.classifier.moderationsApi?.baseUrl,
          submittedBaseUrl: config.classifier.moderationsApi?.baseUrl,
        });
        const plaintextKeys =
          config.classifier.kind === 'moderations_api'
            ? await resolvePlaintextApiKeys({
                add,
                keep,
                secretService,
                storedRefs,
              })
            : [];

        const result = await runClassifierDryRun({
          config,
          db: ctx.serverDB,
          plaintextKeys,
          text: input.text,
        });

        await new PlatformAuditService(ctx.serverDB).append({
          action: CONTENT_MODERATION_AUDIT_ACTIONS.CLASSIFIER_TEST,
          actorUserId: ctx.userId!,
          afterDiff: {
            kind: config.classifier.kind,
            latencyMs: result.latencyMs,
            policyAction: result.policyAction,
          },
          result: 'success',
          targetId: 'default',
          targetType: CONTENT_MODERATION_AUDIT_TARGET_TYPES.SETTINGS,
        });

        return result;
      } catch (error) {
        return mapModerationError(error);
      }
    }),

  updateSettings: moderationManage
    .input(contentModerationSettingsUpdateInputSchema)
    .output(getSettingsOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const catalog = await loadPublishedModelCatalog(ctx.serverDB);
        validateCatalogBoundModels({ catalog, config: input.config });

        const secretService = obtainPlatformSecretService();

        return await ctx.serverDB
          .transaction(async (tx) => {
            const settingsModel = new PlatformContentModerationSettingsModel(
              tx as unknown as LobeChatDatabase,
            );
            const current = await settingsModel.get();
            const persisted = await toPersistedConfig({
              persistedBaseUrl: current?.config.classifier.moderationsApi?.baseUrl,
              secretService,
              storedRefs: current ? storedRefsOf(current.config) : [],
              update: input.config,
            });
            validateCatalogBoundModels({ catalog, config: persisted });
            await assertKeywordRegexesSafe({
              next: persisted.keywords,
              previous: current?.config.keywords ?? null,
            });

            const next = await settingsModel.update({
              config: persisted,
              expectedRevision: input.expectedRevision,
              updatedBy: ctx.userId!,
            });

            const diff = summarizeSettingsDiff({
              next: persisted,
              previous: current?.config ?? null,
            });

            await new PlatformAuditService(tx).append({
              action: CONTENT_MODERATION_AUDIT_ACTIONS.SETTINGS_UPDATE,
              actorUserId: ctx.userId!,
              afterDiff: {
                apiKeyCount: diff.apiKeyCount,
                changedSections: diff.changedSections,
                keywordCount: diff.keywordCount,
                revision: next.revision,
              },
              configRevision: next.revision,
              result: 'success',
              targetId: 'default',
              targetType: CONTENT_MODERATION_AUDIT_TARGET_TYPES.SETTINGS,
            });

            const [settings, roles] = await Promise.all([
              settingsViewFor(tx as unknown as LobeChatDatabase, next),
              loadSystemRoles(tx as unknown as LobeChatDatabase),
            ]);

            return { catalog, roles, settings };
          })
          .then((payload) => {
            invalidateModerationSettingsCache(ctx.serverDB);
            return payload;
          });
      } catch (error) {
        return mapModerationError(error);
      }
    }),
});
