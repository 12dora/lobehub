/**
 * admin.contentModeration.* — platform content-moderation settings, overview, records.
 */
import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { PlatformContentModerationDecisionModel } from '@/database/models/platform/contentModerationDecisions';
import { PlatformContentModerationHourlyStatsModel } from '@/database/models/platform/contentModerationHourlyStats';
import { PlatformContentModerationRecordModel } from '@/database/models/platform/contentModerationRecords';
import { PlatformContentModerationSettingsModel } from '@/database/models/platform/contentModerationSettings';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';
import {
  contentModerationOverviewSchema,
  contentModerationRecordListInputSchema,
  contentModerationRecordListOutputSchema,
  contentModerationSettingsUpdateInputSchema,
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
import { PlatformAuditService } from '../../services/platformAudit';
import { mapModerationError } from './contentModeration.errors';
import { getSettingsPayload, testClassifier, updateSettings } from './contentModeration.handlers';
import {
  clearCacheOutputSchema,
  deleteRecordsInputSchema,
  deleteRecordsOutputSchema,
  getRecordOutputSchema,
  getSettingsOutputSchema,
  idInputSchema,
  revealOutputSchema,
} from './contentModeration.schemas';
import {
  assertStatsRange,
  assertStatsTimeZone,
  buildOverview,
  hasPublishedClientFetchBypass,
  loadRecordUser,
  revealRecordPromptAtomic,
  statsBucketForRange,
} from './contentModerationSupport';

const adminBase = authedProcedure
  .use(serverDatabase)
  .use(withActiveUser())
  .use(withAdminMutationRateLimit());

const moderationRead = adminBase.use(withPlatformPermission(PLATFORM_PERMISSIONS.MODERATION_READ));
const moderationManage = adminBase.use(
  withPlatformPermission(PLATFORM_PERMISSIONS.MODERATION_MANAGE),
);

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
    .mutation(testClassifier),

  updateSettings: moderationManage
    .input(contentModerationSettingsUpdateInputSchema)
    .output(getSettingsOutputSchema)
    .mutation(updateSettings),
});
