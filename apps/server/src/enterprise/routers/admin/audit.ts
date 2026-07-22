/**
 * admin.audit.* — A2 admin audit backend surface.
 *
 * Endpoints:
 * - policy.get / policy.update
 * - events.list / get / facets / stats (+ list/get aliases)
 * - conversations.list / get / messages
 * - users.search / summary / timeline
 * - legalHolds.list / get / create / release
 *
 * No export / retention endpoints in this batch.
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
import { assertRecentReauth } from '../../guards/reauth';
import { AdminAuditService } from '../../services/audit';
import { PlatformAuditService } from '../../services/platformAudit';

const adminBase = authedProcedure
  .use(serverDatabase)
  .use(withActiveUser())
  .use(withAdminMutationRateLimit());

const auditRead = adminBase.use(withPlatformPermission(PLATFORM_PERMISSIONS.AUDIT_READ));
const auditConversationRead = adminBase.use(
  withPlatformPermission(PLATFORM_PERMISSIONS.AUDIT_CONVERSATION_READ),
);
const auditPolicyUpdate = adminBase.use(
  withPlatformPermission(PLATFORM_PERMISSIONS.AUDIT_POLICY_UPDATE),
);
const auditLegalHoldManage = adminBase.use(
  withPlatformPermission(PLATFORM_PERMISSIONS.AUDIT_LEGAL_HOLD_MANAGE),
);

const assertAuditDangerousReauth = async (params: {
  action:
    | 'admin.audit.legalHolds.create'
    | 'admin.audit.legalHolds.release'
    | 'admin.audit.policy.update';
  actorUserId: string;
  authenticatedAt?: Date | null;
  authMethod?: Parameters<typeof assertRecentReauth>[0]['authMethod'];
  reason: string;
  serverDB: LobeChatDatabase;
  targetId?: string;
  targetType: string;
}) => {
  try {
    assertRecentReauth({
      authenticatedAt: params.authenticatedAt,
      authMethod: params.authMethod,
    });
  } catch (error) {
    try {
      await new PlatformAuditService(params.serverDB).append({
        action: params.action,
        actorUserId: params.actorUserId,
        afterDiff: { error: 'reauth_required' },
        reason: params.reason,
        result: 'denied',
        targetId: params.targetId ?? null,
        targetType: params.targetType,
      });
    } catch (auditError) {
      console.error('[admin.audit] reauth denied audit unavailable', {
        action: params.action,
        errorClass: auditError instanceof Error ? auditError.name : 'UnknownError',
      });
    }
    throw error;
  }
};

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

/**
 * Compatibility aliases `list` / `get` → events.list / events.get.
 * Keep shapes aligned with the events surface (list omits diffs; get returns full stored diffs).
 */
export const adminAuditRouter = router({
  conversations: conversationsRouter,
  events: eventsRouter,
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
  users: usersRouter,
});
