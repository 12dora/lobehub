import { router } from '@/libs/trpc/lambda';

import {
  adminAuditExportsCancelInputSchema,
  adminAuditExportsCancelOutputSchema,
  adminAuditExportsCreateInputSchema,
  adminAuditExportsCreateOutputSchema,
  adminAuditExportsDownloadInputSchema,
  adminAuditExportsDownloadOutputSchema,
  adminAuditExportsGetInputSchema,
  adminAuditExportsGetOutputSchema,
  adminAuditExportsListInputSchema,
  adminAuditExportsListOutputSchema,
  adminAuditLegalHoldsCreateInputSchema,
  adminAuditLegalHoldsCreateOutputSchema,
  adminAuditLegalHoldsGetInputSchema,
  adminAuditLegalHoldsGetOutputSchema,
  adminAuditLegalHoldsListInputSchema,
  adminAuditLegalHoldsListOutputSchema,
  adminAuditLegalHoldsReleaseInputSchema,
  adminAuditLegalHoldsReleaseOutputSchema,
  adminAuditRetentionCancelInputSchema,
  adminAuditRetentionCancelOutputSchema,
  adminAuditRetentionCreateInputSchema,
  adminAuditRetentionCreateOutputSchema,
  adminAuditRetentionGetRunInputSchema,
  adminAuditRetentionGetRunOutputSchema,
  adminAuditRetentionListRunsInputSchema,
  adminAuditRetentionListRunsOutputSchema,
  adminAuditRetentionStatusInputSchema,
  adminAuditRetentionStatusOutputSchema,
} from '../../contracts/adminAudit';
import {
  AdminAuditExportService,
  AdminAuditRetentionService,
  AdminAuditService,
} from '../../services/audit';
import {
  assertAuditDangerousReauth,
  auditExport,
  auditLegalHoldManage,
  auditRetentionOperate,
  platformAuthPermissions,
} from './audit.procedure';

export const legalHoldsRouter = router({
  create: auditLegalHoldManage
    .input(adminAuditLegalHoldsCreateInputSchema)
    .output(adminAuditLegalHoldsCreateOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertAuditDangerousReauth({
        action: 'admin.audit.legalHolds.create',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        serverDB: ctx.serverDB,
        targetType: 'legal_hold',
      });
      const service = new AdminAuditService(ctx.serverDB);
      return service.createLegalHold({ actorUserId: ctx.userId!, input });
    }),

  get: auditLegalHoldManage
    .input(adminAuditLegalHoldsGetInputSchema)
    .output(adminAuditLegalHoldsGetOutputSchema)
    .query(async ({ ctx, input }) => {
      const service = new AdminAuditService(ctx.serverDB);
      return service.getLegalHold({ actorUserId: ctx.userId!, id: input.id });
    }),

  list: auditLegalHoldManage
    .input(adminAuditLegalHoldsListInputSchema)
    .output(adminAuditLegalHoldsListOutputSchema)
    .query(async ({ ctx, input }) => {
      const service = new AdminAuditService(ctx.serverDB);
      return service.listLegalHolds({ actorUserId: ctx.userId!, input });
    }),

  release: auditLegalHoldManage
    .input(adminAuditLegalHoldsReleaseInputSchema)
    .output(adminAuditLegalHoldsReleaseOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertAuditDangerousReauth({
        action: 'admin.audit.legalHolds.release',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.releaseReason,
        serverDB: ctx.serverDB,
        targetId: input.id,
        targetType: 'legal_hold',
      });
      const service = new AdminAuditService(ctx.serverDB);
      return service.releaseLegalHold({ actorUserId: ctx.userId!, input });
    }),
});

export const exportsRouter = router({
  cancel: auditExport
    .input(adminAuditExportsCancelInputSchema)
    .output(adminAuditExportsCancelOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertAuditDangerousReauth({
        action: 'admin.audit.exports.cancel',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        serverDB: ctx.serverDB,
        targetId: input.id,
        targetType: 'audit_export',
      });
      const service = new AdminAuditExportService(ctx.serverDB);
      return service.cancel({
        actorPermissions: platformAuthPermissions(ctx),
        actorUserId: ctx.userId!,
        input,
      });
    }),

  create: auditExport
    .input(adminAuditExportsCreateInputSchema)
    .output(adminAuditExportsCreateOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertAuditDangerousReauth({
        action: 'admin.audit.exports.create',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        serverDB: ctx.serverDB,
        targetType: 'audit_export',
      });
      const service = new AdminAuditExportService(ctx.serverDB);
      return service.create({
        actorPermissions: platformAuthPermissions(ctx),
        actorUserId: ctx.userId!,
        input,
      });
    }),

  download: auditExport
    .input(adminAuditExportsDownloadInputSchema)
    .output(adminAuditExportsDownloadOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertAuditDangerousReauth({
        action: 'admin.audit.exports.download',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        serverDB: ctx.serverDB,
        targetId: input.id,
        targetType: 'audit_export',
      });
      const service = new AdminAuditExportService(ctx.serverDB);
      return service.download({
        actorPermissions: platformAuthPermissions(ctx),
        actorUserId: ctx.userId!,
        input,
      });
    }),

  get: auditExport
    .input(adminAuditExportsGetInputSchema)
    .output(adminAuditExportsGetOutputSchema)
    .query(async ({ ctx, input }) => {
      const service = new AdminAuditExportService(ctx.serverDB);
      return service.get({
        actorPermissions: platformAuthPermissions(ctx),
        actorUserId: ctx.userId!,
        id: input.id,
      });
    }),

  list: auditExport
    .input(adminAuditExportsListInputSchema)
    .output(adminAuditExportsListOutputSchema)
    .query(async ({ ctx, input }) => {
      const service = new AdminAuditExportService(ctx.serverDB);
      return service.list({
        actorPermissions: platformAuthPermissions(ctx),
        actorUserId: ctx.userId!,
        input,
      });
    }),
});

export const retentionRouter = router({
  cancel: auditRetentionOperate
    .input(adminAuditRetentionCancelInputSchema)
    .output(adminAuditRetentionCancelOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertAuditDangerousReauth({
        action: 'admin.audit.retention.cancel',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        serverDB: ctx.serverDB,
        targetId: input.id,
        targetType: 'audit_retention_run',
      });
      const service = new AdminAuditRetentionService(ctx.serverDB);
      return service.cancel({ actorUserId: ctx.userId!, input });
    }),

  dryRun: auditRetentionOperate
    .input(adminAuditRetentionCreateInputSchema)
    .output(adminAuditRetentionCreateOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertAuditDangerousReauth({
        action: 'admin.audit.retention.dryRun',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        serverDB: ctx.serverDB,
        targetType: 'audit_retention_run',
      });
      const service = new AdminAuditRetentionService(ctx.serverDB);
      return service.dryRun({ actorUserId: ctx.userId!, input });
    }),

  getRun: auditRetentionOperate
    .input(adminAuditRetentionGetRunInputSchema)
    .output(adminAuditRetentionGetRunOutputSchema)
    .query(async ({ ctx, input }) => {
      const service = new AdminAuditRetentionService(ctx.serverDB);
      return service.getRun({ actorUserId: ctx.userId!, id: input.id });
    }),

  listRuns: auditRetentionOperate
    .input(adminAuditRetentionListRunsInputSchema)
    .output(adminAuditRetentionListRunsOutputSchema)
    .query(async ({ ctx, input }) => {
      const service = new AdminAuditRetentionService(ctx.serverDB);
      return service.listRuns({ actorUserId: ctx.userId!, input });
    }),

  run: auditRetentionOperate
    .input(adminAuditRetentionCreateInputSchema)
    .output(adminAuditRetentionCreateOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertAuditDangerousReauth({
        action: 'admin.audit.retention.run',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        serverDB: ctx.serverDB,
        targetType: 'audit_retention_run',
      });
      const service = new AdminAuditRetentionService(ctx.serverDB);
      return service.run({ actorUserId: ctx.userId!, input });
    }),

  /** Alias of getRun for frontend polling convenience. */
  status: auditRetentionOperate
    .input(adminAuditRetentionStatusInputSchema)
    .output(adminAuditRetentionStatusOutputSchema)
    .query(async ({ ctx, input }) => {
      const service = new AdminAuditRetentionService(ctx.serverDB);
      return service.status({ actorUserId: ctx.userId!, id: input.id });
    }),
});
