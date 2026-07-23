/**
 * admin.audit.* — A2 evidence query + A3 export/retention surface.
 *
 * Endpoints:
 * - policy.get / policy.update
 * - events.list / get / facets / stats (+ list/get aliases)
 * - conversations.list / get / messages
 * - users.search / summary / timeline
 * - legalHolds.list / get / create / release
 * - exports.create / list / get / download / cancel
 * - retention.dryRun / run / listRuns / getRun / status / cancel
 */

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import type { LobeChatDatabase } from '@/database/type';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import {
  adminAuditConversationsGetInputSchema,
  adminAuditConversationsGetOutputSchema,
  adminAuditConversationsListInputSchema,
  adminAuditConversationsListOutputSchema,
  adminAuditConversationsMessagesInputSchema,
  adminAuditConversationsMessagesOutputSchema,
  adminAuditEventsFacetsInputSchema,
  adminAuditEventsFacetsOutputSchema,
  adminAuditEventsGetInputSchema,
  adminAuditEventsGetOutputSchema,
  adminAuditEventsListInputSchema,
  adminAuditEventsListOutputSchema,
  adminAuditEventsStatsInputSchema,
  adminAuditEventsStatsOutputSchema,
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
  adminAuditPolicyGetOutputSchema,
  adminAuditPolicyUpdateInputSchema,
  adminAuditPolicyUpdateOutputSchema,
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
  adminAuditUsersSearchInputSchema,
  adminAuditUsersSearchOutputSchema,
  adminAuditUsersSummaryInputSchema,
  adminAuditUsersSummaryOutputSchema,
  adminAuditUsersTimelineInputSchema,
  adminAuditUsersTimelineOutputSchema,
} from '../../contracts/adminAudit';
import { withActiveUser } from '../../guards/activeUser';
import { withAdminMutationRateLimit } from '../../guards/adminMutationRateLimit';
import { withPlatformPermission } from '../../guards/platformPermission';
import { assertDangerousReauthWithAudit } from '../../guards/reauth';
import {
  AdminAuditExportService,
  AdminAuditRetentionService,
  AdminAuditService,
} from '../../services/audit';

const adminBase = authedProcedure
  .use(serverDatabase)
  .use(withActiveUser())
  .use(withAdminMutationRateLimit());

const auditRead = adminBase.use(withPlatformPermission(PLATFORM_PERMISSIONS.AUDIT_READ));
const auditConversationRead = adminBase.use(
  withPlatformPermission(PLATFORM_PERMISSIONS.AUDIT_CONVERSATION_READ),
);
const auditExport = adminBase.use(withPlatformPermission(PLATFORM_PERMISSIONS.AUDIT_EXPORT));
const auditRetentionOperate = adminBase.use(
  withPlatformPermission(PLATFORM_PERMISSIONS.AUDIT_RETENTION_OPERATE),
);
const auditPolicyUpdate = adminBase.use(
  withPlatformPermission(PLATFORM_PERMISSIONS.AUDIT_POLICY_UPDATE),
);
const auditLegalHoldManage = adminBase.use(
  withPlatformPermission(PLATFORM_PERMISSIONS.AUDIT_LEGAL_HOLD_MANAGE),
);

const assertAuditDangerousReauth = async (params: {
  action:
    | 'admin.audit.exports.cancel'
    | 'admin.audit.exports.create'
    | 'admin.audit.exports.download'
    | 'admin.audit.legalHolds.create'
    | 'admin.audit.legalHolds.release'
    | 'admin.audit.policy.update'
    | 'admin.audit.retention.cancel'
    | 'admin.audit.retention.dryRun'
    | 'admin.audit.retention.run';
  actorUserId: string;
  authenticatedAt?: Date | null;
  authMethod?: Parameters<typeof assertDangerousReauthWithAudit>[0]['authMethod'];
  reason: string;
  serverDB: LobeChatDatabase;
  targetId?: string;
  targetType: string;
}) =>
  assertDangerousReauthWithAudit({
    action: params.action,
    actorUserId: params.actorUserId,
    auditFailureLog: '[admin.audit] reauth denied audit unavailable',
    authenticatedAt: params.authenticatedAt,
    authMethod: params.authMethod,
    reason: params.reason,
    serverDB: params.serverDB,
    targetId: params.targetId ?? null,
    targetType: params.targetType,
  });

const policyRouter = router({
  get: auditRead.output(adminAuditPolicyGetOutputSchema).query(async ({ ctx }) => {
    const service = new AdminAuditService(ctx.serverDB);
    return service.getPolicy({ actorUserId: ctx.userId! });
  }),

  update: auditPolicyUpdate
    .input(adminAuditPolicyUpdateInputSchema)
    .output(adminAuditPolicyUpdateOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertAuditDangerousReauth({
        action: 'admin.audit.policy.update',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        serverDB: ctx.serverDB,
        targetId: 'global',
        targetType: 'audit_policy',
      });
      const service = new AdminAuditService(ctx.serverDB);
      return service.updatePolicy({ actorUserId: ctx.userId!, input });
    }),
});

const eventsRouter = router({
  facets: auditRead
    .input(adminAuditEventsFacetsInputSchema)
    .output(adminAuditEventsFacetsOutputSchema)
    .query(async ({ ctx, input }) => {
      const service = new AdminAuditService(ctx.serverDB);
      return service.getEventFacets({ actorUserId: ctx.userId!, input });
    }),

  get: auditRead
    .input(adminAuditEventsGetInputSchema)
    .output(adminAuditEventsGetOutputSchema)
    .query(async ({ ctx, input }) => {
      const service = new AdminAuditService(ctx.serverDB);
      return service.getEvent({
        accessAction: 'admin.audit.events.get',
        actorUserId: ctx.userId!,
        id: input.id,
      });
    }),

  list: auditRead
    .input(adminAuditEventsListInputSchema)
    .output(adminAuditEventsListOutputSchema)
    .query(async ({ ctx, input }) => {
      const service = new AdminAuditService(ctx.serverDB);
      return service.listEvents({
        accessAction: 'admin.audit.events.list',
        actorUserId: ctx.userId!,
        input,
      });
    }),

  stats: auditRead
    .input(adminAuditEventsStatsInputSchema)
    .output(adminAuditEventsStatsOutputSchema)
    .query(async ({ ctx, input }) => {
      const service = new AdminAuditService(ctx.serverDB);
      return service.getEventStats({ actorUserId: ctx.userId!, input });
    }),
});

const conversationsRouter = router({
  get: auditConversationRead
    .input(adminAuditConversationsGetInputSchema)
    .output(adminAuditConversationsGetOutputSchema)
    .query(async ({ ctx, input }) => {
      const service = new AdminAuditService(ctx.serverDB);
      return service.getConversation({ actorUserId: ctx.userId!, input });
    }),

  list: auditConversationRead
    .input(adminAuditConversationsListInputSchema)
    .output(adminAuditConversationsListOutputSchema)
    .query(async ({ ctx, input }) => {
      const service = new AdminAuditService(ctx.serverDB);
      return service.listConversations({ actorUserId: ctx.userId!, input });
    }),

  messages: auditConversationRead
    .input(adminAuditConversationsMessagesInputSchema)
    .output(adminAuditConversationsMessagesOutputSchema)
    .query(async ({ ctx, input }) => {
      const service = new AdminAuditService(ctx.serverDB);
      return service.listConversationMessages({ actorUserId: ctx.userId!, input });
    }),
});

const usersRouter = router({
  search: auditRead
    .input(adminAuditUsersSearchInputSchema)
    .output(adminAuditUsersSearchOutputSchema)
    .query(async ({ ctx, input }) => {
      const service = new AdminAuditService(ctx.serverDB);
      return service.searchUsers({ actorUserId: ctx.userId!, input });
    }),

  summary: auditRead
    .input(adminAuditUsersSummaryInputSchema)
    .output(adminAuditUsersSummaryOutputSchema)
    .query(async ({ ctx, input }) => {
      const service = new AdminAuditService(ctx.serverDB);
      return service.getUserSummary({ actorUserId: ctx.userId!, userId: input.userId });
    }),

  timeline: auditRead
    .input(adminAuditUsersTimelineInputSchema)
    .output(adminAuditUsersTimelineOutputSchema)
    .query(async ({ ctx, input }) => {
      const service = new AdminAuditService(ctx.serverDB);
      return service.listUserTimeline({ actorUserId: ctx.userId!, input });
    }),
});

const legalHoldsRouter = router({
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

/** Server-derived permissions from withPlatformPermission — never client-supplied. */
const platformAuthPermissions = (ctx: {
  platformAuth?: { permissions?: readonly string[] };
}): readonly string[] | undefined => ctx.platformAuth?.permissions;

const exportsRouter = router({
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

const retentionRouter = router({
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

/**
 * Compatibility aliases `list` / `get` → events.list / events.get.
 * Keep shapes aligned with the events surface (list omits diffs; get returns full stored diffs).
 */
export const adminAuditRouter = router({
  conversations: conversationsRouter,
  events: eventsRouter,
  exports: exportsRouter,
  get: auditRead
    .input(adminAuditEventsGetInputSchema)
    .output(adminAuditEventsGetOutputSchema)
    .query(async ({ ctx, input }) => {
      const service = new AdminAuditService(ctx.serverDB);
      return service.getEvent({
        accessAction: 'admin.audit.get',
        actorUserId: ctx.userId!,
        id: input.id,
      });
    }),
  legalHolds: legalHoldsRouter,
  list: auditRead
    .input(adminAuditEventsListInputSchema)
    .output(adminAuditEventsListOutputSchema)
    .query(async ({ ctx, input }) => {
      const service = new AdminAuditService(ctx.serverDB);
      return service.listEvents({
        accessAction: 'admin.audit.list',
        actorUserId: ctx.userId!,
        input,
      });
    }),
  policy: policyRouter,
  retention: retentionRouter,
  users: usersRouter,
});
