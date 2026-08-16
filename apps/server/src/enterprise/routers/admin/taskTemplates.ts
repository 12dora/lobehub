import { randomUUID } from 'node:crypto';

import { TRPCError } from '@trpc/server';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import {
  PlatformTaskTemplateIdentifierConflictError,
  PlatformTaskTemplateModel,
} from '@/database/models/platform';
import { PlatformRevisionConflictError } from '@/database/models/platform/errors';
import type { LobeChatDatabase } from '@/database/type';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';
import { TaskTemplateMarketTimeoutError } from '@/server/services/taskTemplate';

import {
  adminTaskTemplateCreateInputSchema,
  adminTaskTemplateDeleteInputSchema,
  adminTaskTemplateDeleteOutputSchema,
  adminTaskTemplateImportInputSchema,
  adminTaskTemplateImportOutputSchema,
  adminTaskTemplateItemSchema,
  adminTaskTemplateListInputSchema,
  adminTaskTemplateListOutputSchema,
  adminTaskTemplateSetEnabledInputSchema,
  adminTaskTemplateUpdateInputSchema,
} from '../../contracts/adminTaskTemplates';
import { withActiveUser } from '../../guards/activeUser';
import { withAdminMutationRateLimit } from '../../guards/adminMutationRateLimit';
import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import {
  withAllPlatformPermissions,
  withPlatformPermission,
} from '../../guards/platformPermission';
import { PlatformAuditService } from '../../services/platformAudit';
import {
  deriveTaskTemplateIdentifier,
  fetchMarketTaskTemplatesForImport,
  toAdminTaskTemplateItem,
  toTaskTemplateAuditDiff,
} from './taskTemplatesSupport';

const taskTemplateBase = authedProcedure
  .use(serverDatabase)
  .use(withActiveUser())
  .use(withAdminMutationRateLimit());

/**
 * Task templates reuse the **platform-agent** permission codes (AGENT_READ / AGENT_CREATE /
 * AGENT_UPDATE / AGENT_DELETE) on purpose: a task template is authored content that produces a
 * scheduled task on the inbox agent, and reusing the existing codes means an installed
 * deployment does not have to re-seed RBAC to get this module.
 */
const readProcedure = taskTemplateBase.use(withPlatformPermission(PLATFORM_PERMISSIONS.AGENT_READ));
const createProcedure = taskTemplateBase.use(
  withPlatformPermission(PLATFORM_PERMISSIONS.AGENT_CREATE),
);
const updateProcedure = taskTemplateBase.use(
  withPlatformPermission(PLATFORM_PERMISSIONS.AGENT_UPDATE),
);
const deleteProcedure = taskTemplateBase.use(
  withPlatformPermission(PLATFORM_PERMISSIONS.AGENT_DELETE),
);
/**
 * Import both creates rows and overwrites the content of rows that already exist, so a
 * create-only operator must not be able to run it: it needs CREATE **and** UPDATE.
 */
const importProcedure = taskTemplateBase.use(
  withAllPlatformPermissions([
    PLATFORM_PERMISSIONS.AGENT_CREATE,
    PLATFORM_PERMISSIONS.AGENT_UPDATE,
  ]),
);

const conflict = (error: PlatformRevisionConflictError): never =>
  throwEnterpriseError({
    code: PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT,
    details: error.details as Record<string, string | number | boolean | null> | undefined,
  });

const identifierTaken = (identifier: string): never =>
  throwEnterpriseError({
    code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
    details: { field: 'identifier', identifier, reason: 'identifier_taken' },
    httpCode: 'BAD_REQUEST',
  });

const notFound = (): never =>
  throwEnterpriseError({
    code: PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND,
    httpCode: 'NOT_FOUND',
  });

const writeFailed = (): never =>
  throwEnterpriseError({
    code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
    details: { issueCount: 1, reason: 'audit_or_write_failed' },
    httpCode: 'INTERNAL_SERVER_ERROR',
  });

const marketUnavailable = (
  reason: 'market_recommendations_timeout' | 'market_recommendations_unavailable',
): never =>
  throwEnterpriseError({
    code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
    details: { issueCount: 1, reason },
    httpCode: 'BAD_GATEWAY',
  });

/** Shared tail for every mutation: known business errors keep their code, the rest are sanitized. */
const mapWriteError = (error: unknown): never => {
  if (error instanceof TRPCError) throw error;
  if (error instanceof PlatformRevisionConflictError) return conflict(error);
  if (error instanceof PlatformTaskTemplateIdentifierConflictError) {
    return identifierTaken(error.identifier);
  }
  return writeFailed();
};

/**
 * admin.taskTemplates — platform-managed 任务模板.
 *
 * Direct-save (no draft/publish, no PlatformPublisherService): every mutation writes the row
 * and appends its success audit inside one transaction, so an unavailable audit sink cannot
 * leave an unaudited committed change. Every write is conditional on the row's `revision`.
 */
export const adminTaskTemplatesRouter = router({
  create: createProcedure
    .input(adminTaskTemplateCreateInputSchema)
    .output(adminTaskTemplateItemSchema)
    .mutation(async ({ ctx, input }) => {
      const { identifier, ...document } = input;
      try {
        return await ctx.serverDB.transaction(async (tx) => {
          const model = new PlatformTaskTemplateModel(tx as unknown as LobeChatDatabase);
          const created = await model.create({
            actorUserId: ctx.userId!,
            document: { ...document, icon: document.icon ?? null },
            id: randomUUID(),
            identifier: identifier ?? deriveTaskTemplateIdentifier(document.title),
            source: 'manual',
          });

          await new PlatformAuditService(tx).append({
            action: 'admin.taskTemplates.create',
            actorUserId: ctx.userId!,
            afterDiff: toTaskTemplateAuditDiff(created),
            configRevision: created.revision,
            result: 'success',
            targetId: created.id,
            targetType: 'task_template',
          });

          return toAdminTaskTemplateItem(created);
        });
      } catch (error) {
        return mapWriteError(error);
      }
    }),

  delete: deleteProcedure
    .input(adminTaskTemplateDeleteInputSchema)
    .output(adminTaskTemplateDeleteOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.serverDB.transaction(async (tx) => {
          const model = new PlatformTaskTemplateModel(tx as unknown as LobeChatDatabase);
          const removed = await model.delete({
            expectedRevision: input.expectedRevision,
            id: input.id,
          });
          if (!removed) return notFound();

          await new PlatformAuditService(tx).append({
            action: 'admin.taskTemplates.delete',
            actorUserId: ctx.userId!,
            // Deletion has no "after" — the removed state is the evidence.
            beforeDiff: toTaskTemplateAuditDiff(removed),
            configRevision: removed.revision,
            result: 'success',
            targetId: removed.id,
            targetType: 'task_template',
          });

          return { id: removed.id };
        });
      } catch (error) {
        return mapWriteError(error);
      }
    }),

  /**
   * 从推荐库导入 — pull the current market recommendations and upsert them by `identifier`.
   * Idempotent: content columns are refreshed while an existing row keeps the operator's own
   * `enabled` / `sortOrder` choices. Imported rows are created enabled.
   */
  importRecommendations: importProcedure
    .input(adminTaskTemplateImportInputSchema)
    .output(adminTaskTemplateImportOutputSchema)
    .mutation(async ({ ctx, input }) => {
      // Outbound market call stays outside the transaction (bounded by its own deadline) so a
      // slow remote can neither hold row locks nor hang the mutation.
      let fetched: Awaited<ReturnType<typeof fetchMarketTaskTemplatesForImport>>;
      try {
        fetched = await fetchMarketTaskTemplatesForImport({
          locale: input.locale,
          userId: ctx.userId!,
        });
      } catch (error) {
        return marketUnavailable(
          error instanceof TaskTemplateMarketTimeoutError
            ? 'market_recommendations_timeout'
            : 'market_recommendations_unavailable',
        );
      }

      try {
        return await ctx.serverDB.transaction(async (tx) => {
          const model = new PlatformTaskTemplateModel(tx as unknown as LobeChatDatabase);
          const { changes, created, updated } = await model.importByIdentifier({
            actorUserId: ctx.userId!,
            nextId: () => randomUUID(),
            rows: fetched.rows,
          });

          await new PlatformAuditService(tx).append({
            action: 'admin.taskTemplates.importRecommendations',
            actorUserId: ctx.userId!,
            // Per-identifier evidence: what each row became. Bounded by the import cap.
            afterDiff: {
              created,
              rows: changes.map((change) => ({
                identifier: change.identifier,
                inserted: change.inserted,
                ...(change.after ? toTaskTemplateAuditDiff(change.after) : {}),
              })),
              skipped: fetched.skipped,
              updated,
            },
            // …and what each overwritten row replaced, so an auditor can see the content an
            // import discarded rather than only how many rows it touched.
            beforeDiff: {
              rows: changes
                .filter((change) => change.before)
                .map((change) => ({
                  identifier: change.identifier,
                  ...toTaskTemplateAuditDiff(change.before!),
                })),
            },
            result: 'success',
            targetId: 'market',
            targetType: 'task_template',
          });

          return { created, skipped: fetched.skipped, updated };
        });
      } catch (error) {
        return mapWriteError(error);
      }
    }),

  list: readProcedure
    .input(adminTaskTemplateListInputSchema)
    .output(adminTaskTemplateListOutputSchema)
    .query(async ({ ctx, input }) => {
      const model = new PlatformTaskTemplateModel(ctx.serverDB);
      const [page, totalAll] = await Promise.all([
        model.list({
          enabled: input.enabled,
          limit: input.limit,
          offset: input.offset,
          query: input.query,
        }),
        model.count(),
      ]);

      return {
        items: page.items.map((row) => toAdminTaskTemplateItem(row)),
        totalAll,
        totalFiltered: page.total,
      };
    }),

  setEnabled: updateProcedure
    .input(adminTaskTemplateSetEnabledInputSchema)
    .output(adminTaskTemplateItemSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.serverDB.transaction(async (tx) => {
          const model = new PlatformTaskTemplateModel(tx as unknown as LobeChatDatabase);
          const before = await model.findById(input.id);
          const next = await model.setEnabled({
            actorUserId: ctx.userId!,
            enabled: input.enabled,
            expectedRevision: input.expectedRevision,
            id: input.id,
          });
          if (!next) return notFound();

          await new PlatformAuditService(tx).append({
            action: 'admin.taskTemplates.setEnabled',
            actorUserId: ctx.userId!,
            afterDiff: toTaskTemplateAuditDiff(next),
            beforeDiff: before ? toTaskTemplateAuditDiff(before) : undefined,
            configRevision: next.revision,
            result: 'success',
            targetId: next.id,
            targetType: 'task_template',
          });

          return toAdminTaskTemplateItem(next);
        });
      } catch (error) {
        return mapWriteError(error);
      }
    }),

  update: updateProcedure
    .input(adminTaskTemplateUpdateInputSchema)
    .output(adminTaskTemplateItemSchema)
    .mutation(async ({ ctx, input }) => {
      const { expectedRevision, id, ...document } = input;
      try {
        return await ctx.serverDB.transaction(async (tx) => {
          const model = new PlatformTaskTemplateModel(tx as unknown as LobeChatDatabase);
          const before = await model.findById(id);
          const next = await model.update({
            actorUserId: ctx.userId!,
            document: { ...document, icon: document.icon ?? null },
            expectedRevision,
            id,
          });

          await new PlatformAuditService(tx).append({
            action: 'admin.taskTemplates.update',
            actorUserId: ctx.userId!,
            afterDiff: toTaskTemplateAuditDiff(next),
            beforeDiff: before ? toTaskTemplateAuditDiff(before) : undefined,
            configRevision: next.revision,
            result: 'success',
            targetId: next.id,
            targetType: 'task_template',
          });

          return toAdminTaskTemplateItem(next);
        });
      } catch (error) {
        return mapWriteError(error);
      }
    }),
});
