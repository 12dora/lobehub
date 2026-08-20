import { randomUUID } from 'node:crypto';

import { TRPCError } from '@trpc/server';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import {
  PlatformAgentTemplateIdentifierConflictError,
  PlatformAgentTemplateModel,
} from '@/database/models/platform';
import { PlatformRevisionConflictError } from '@/database/models/platform/errors';
import type { LobeChatDatabase } from '@/database/type';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import {
  adminAgentTemplateCreateInputSchema,
  adminAgentTemplateDeleteInputSchema,
  adminAgentTemplateDeleteOutputSchema,
  adminAgentTemplateImportInputSchema,
  adminAgentTemplateImportOutputSchema,
  adminAgentTemplateItemSchema,
  adminAgentTemplateListInputSchema,
  adminAgentTemplateListOutputSchema,
  adminAgentTemplateReorderInputSchema,
  adminAgentTemplateReorderOutputSchema,
  adminAgentTemplateSetEnabledInputSchema,
  adminAgentTemplateUpdateInputSchema,
} from '../../contracts/adminAgentTemplates';
import { withActiveUser } from '../../guards/activeUser';
import { withAdminMutationRateLimit } from '../../guards/adminMutationRateLimit';
import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import {
  withAllPlatformPermissions,
  withPlatformPermission,
} from '../../guards/platformPermission';
import { PlatformAuditService } from '../../services/platformAudit';
import {
  deriveAgentTemplateIdentifier,
  fetchBuiltInAgentTemplatesForImport,
  listUnmanagedAgentTemplatePreview,
  toAdminAgentTemplateItem,
  toAgentTemplateAuditDiff,
} from './agentTemplatesSupport';

const agentTemplateBase = authedProcedure
  .use(serverDatabase)
  .use(withActiveUser())
  .use(withAdminMutationRateLimit());

/**
 * Agent templates reuse the **platform-agent** permission codes (AGENT_READ / AGENT_CREATE /
 * AGENT_UPDATE / AGENT_DELETE) on purpose: an agent template is authored content that prefills
 * the create-agent modal, and reusing the existing codes means an installed deployment does
 * not have to re-seed RBAC to get this module. They also share the `taskTemplates` module id.
 */
const readProcedure = agentTemplateBase.use(
  withPlatformPermission(PLATFORM_PERMISSIONS.AGENT_READ),
);
const createProcedure = agentTemplateBase.use(
  withPlatformPermission(PLATFORM_PERMISSIONS.AGENT_CREATE),
);
const updateProcedure = agentTemplateBase.use(
  withPlatformPermission(PLATFORM_PERMISSIONS.AGENT_UPDATE),
);
const deleteProcedure = agentTemplateBase.use(
  withPlatformPermission(PLATFORM_PERMISSIONS.AGENT_DELETE),
);
/**
 * Import both creates rows and overwrites the content of rows that already exist, so a
 * create-only operator must not be able to run it: it needs CREATE **and** UPDATE.
 */
const importProcedure = agentTemplateBase.use(
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

/** Shared tail for every mutation: known business errors keep their code, the rest are sanitized. */
const mapWriteError = (error: unknown): never => {
  if (error instanceof TRPCError) throw error;
  if (error instanceof PlatformRevisionConflictError) return conflict(error);
  if (error instanceof PlatformAgentTemplateIdentifierConflictError) {
    return identifierTaken(error.identifier);
  }
  return writeFailed();
};

/**
 * admin.agentTemplates — platform-managed 助理模板.
 *
 * Direct-save (no draft/publish, no PlatformPublisherService): every mutation writes the row
 * and appends its success audit inside one transaction, so an unavailable audit sink cannot
 * leave an unaudited committed change. Every write is conditional on the row's `revision`.
 */
export const adminAgentTemplatesRouter = router({
  create: createProcedure
    .input(adminAgentTemplateCreateInputSchema)
    .output(adminAgentTemplateItemSchema)
    .mutation(async ({ ctx, input }) => {
      const { identifier, ...document } = input;
      try {
        return await ctx.serverDB.transaction(async (tx) => {
          const model = new PlatformAgentTemplateModel(tx as unknown as LobeChatDatabase);
          const created = await model.create({
            actorUserId: ctx.userId!,
            document: {
              ...document,
              avatar: document.avatar ?? null,
              backgroundColor: document.backgroundColor ?? null,
            },
            id: randomUUID(),
            identifier: identifier ?? deriveAgentTemplateIdentifier(document.title),
            source: 'manual',
          });

          await new PlatformAuditService(tx).append({
            action: 'admin.agentTemplates.create',
            actorUserId: ctx.userId!,
            afterDiff: toAgentTemplateAuditDiff(created),
            configRevision: created.revision,
            result: 'success',
            targetId: created.id,
            targetType: 'agent_template',
          });

          return toAdminAgentTemplateItem(created);
        });
      } catch (error) {
        return mapWriteError(error);
      }
    }),

  delete: deleteProcedure
    .input(adminAgentTemplateDeleteInputSchema)
    .output(adminAgentTemplateDeleteOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.serverDB.transaction(async (tx) => {
          const model = new PlatformAgentTemplateModel(tx as unknown as LobeChatDatabase);
          const removed = await model.delete({
            expectedRevision: input.expectedRevision,
            id: input.id,
          });
          if (!removed) return notFound();

          await new PlatformAuditService(tx).append({
            action: 'admin.agentTemplates.delete',
            actorUserId: ctx.userId!,
            // Deletion has no "after" — the removed state is the evidence.
            beforeDiff: toAgentTemplateAuditDiff(removed),
            configRevision: removed.revision,
            result: 'success',
            targetId: removed.id,
            targetType: 'agent_template',
          });

          return { id: removed.id };
        });
      } catch (error) {
        return mapWriteError(error);
      }
    }),

  /**
   * 导入内置示例 — upsert `suggestQuestions:agent.01` … `agent.40` by `identifier`.
   * Idempotent: content columns are refreshed while an existing row keeps the operator's own
   * `enabled` / `sortOrder` choices. Imported rows are created enabled.
   */
  importBuiltins: importProcedure
    .input(adminAgentTemplateImportInputSchema)
    .output(adminAgentTemplateImportOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const fetched = fetchBuiltInAgentTemplatesForImport({ locale: input.locale });

      try {
        return await ctx.serverDB.transaction(async (tx) => {
          const model = new PlatformAgentTemplateModel(tx as unknown as LobeChatDatabase);
          const { changes, created, updated } = await model.importByIdentifier({
            actorUserId: ctx.userId!,
            nextId: () => randomUUID(),
            rows: fetched.rows,
          });

          await new PlatformAuditService(tx).append({
            action: 'admin.agentTemplates.importBuiltins',
            actorUserId: ctx.userId!,
            afterDiff: {
              created,
              rows: changes.map((change) => ({
                identifier: change.identifier,
                inserted: change.inserted,
                ...(change.after ? toAgentTemplateAuditDiff(change.after) : {}),
              })),
              skipped: fetched.skipped,
              updated,
            },
            beforeDiff: {
              rows: changes
                .filter((change) => change.before)
                .map((change) => ({
                  identifier: change.identifier,
                  ...toAgentTemplateAuditDiff(change.before!),
                })),
            },
            result: 'success',
            targetId: 'builtins',
            targetType: 'agent_template',
          });

          return { created, skipped: fetched.skipped, updated };
        });
      } catch (error) {
        return mapWriteError(error);
      }
    }),

  list: readProcedure
    .input(adminAgentTemplateListInputSchema)
    .output(adminAgentTemplateListOutputSchema)
    .query(async ({ ctx, input }) => {
      const model = new PlatformAgentTemplateModel(ctx.serverDB);
      const totalAll = await model.count();
      // Empty table: show the locale examples users currently see. Do not auto-import —
      // that would flip `managed: true` and change the user-facing catalog.
      if (totalAll === 0) return listUnmanagedAgentTemplatePreview(input);

      const page = await model.list({
        enabled: input.enabled,
        limit: input.limit,
        offset: input.offset,
        query: input.query,
      });

      return {
        items: page.items.map((row) => toAdminAgentTemplateItem(row)),
        origin: 'managed',
        totalAll,
        totalFiltered: page.total,
      };
    }),

  /**
   * Persist the display order the operator dragged into place.
   * Same permission as any other edit; one transaction, CAS-checked per row.
   */
  reorder: updateProcedure
    .input(adminAgentTemplateReorderInputSchema)
    .output(adminAgentTemplateReorderOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.serverDB.transaction(async (tx) => {
          const model = new PlatformAgentTemplateModel(tx as unknown as LobeChatDatabase);
          const items = await model.reorder({ actorUserId: ctx.userId!, items: input.items });
          if (!items) return notFound();

          await new PlatformAuditService(tx).append({
            action: 'admin.agentTemplates.reorder',
            actorUserId: ctx.userId!,
            afterDiff: {
              order: items.map((item) => item.identifier),
              sortOrders: items.map((item) => item.sortOrder),
            },
            result: 'success',
            targetId: 'order',
            targetType: 'agent_template',
          });

          return { items: items.map((item) => toAdminAgentTemplateItem(item)) };
        });
      } catch (error) {
        return mapWriteError(error);
      }
    }),

  setEnabled: updateProcedure
    .input(adminAgentTemplateSetEnabledInputSchema)
    .output(adminAgentTemplateItemSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.serverDB.transaction(async (tx) => {
          const model = new PlatformAgentTemplateModel(tx as unknown as LobeChatDatabase);
          const before = await model.findById(input.id);
          const next = await model.setEnabled({
            actorUserId: ctx.userId!,
            enabled: input.enabled,
            expectedRevision: input.expectedRevision,
            id: input.id,
          });
          if (!next) return notFound();

          await new PlatformAuditService(tx).append({
            action: 'admin.agentTemplates.setEnabled',
            actorUserId: ctx.userId!,
            afterDiff: toAgentTemplateAuditDiff(next),
            beforeDiff: before ? toAgentTemplateAuditDiff(before) : undefined,
            configRevision: next.revision,
            result: 'success',
            targetId: next.id,
            targetType: 'agent_template',
          });

          return toAdminAgentTemplateItem(next);
        });
      } catch (error) {
        return mapWriteError(error);
      }
    }),

  update: updateProcedure
    .input(adminAgentTemplateUpdateInputSchema)
    .output(adminAgentTemplateItemSchema)
    .mutation(async ({ ctx, input }) => {
      const { expectedRevision, id, ...document } = input;
      try {
        return await ctx.serverDB.transaction(async (tx) => {
          const model = new PlatformAgentTemplateModel(tx as unknown as LobeChatDatabase);
          const before = await model.findById(id);
          const next = await model.update({
            actorUserId: ctx.userId!,
            document: {
              ...document,
              avatar: document.avatar ?? null,
              backgroundColor: document.backgroundColor ?? null,
            },
            expectedRevision,
            id,
          });

          await new PlatformAuditService(tx).append({
            action: 'admin.agentTemplates.update',
            actorUserId: ctx.userId!,
            afterDiff: toAgentTemplateAuditDiff(next),
            beforeDiff: before ? toAgentTemplateAuditDiff(before) : undefined,
            configRevision: next.revision,
            result: 'success',
            targetId: next.id,
            targetType: 'agent_template',
          });

          return toAdminAgentTemplateItem(next);
        });
      } catch (error) {
        return mapWriteError(error);
      }
    }),
});
