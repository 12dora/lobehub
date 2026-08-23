import { router } from '@/libs/trpc/lambda';

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
import { AdminAuditService } from '../../services/audit';
import {
  assertAuditDangerousReauth,
  auditConversationRead,
  auditPolicyUpdate,
  auditRead,
} from './audit.procedure';

export const policyRouter = router({
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

export const eventsRouter = router({
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

export const conversationsRouter = router({
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

export const usersRouter = router({
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

  timeline: auditConversationRead
    .input(adminAuditUsersTimelineInputSchema)
    .output(adminAuditUsersTimelineOutputSchema)
    .query(async ({ ctx, input }) => {
      const service = new AdminAuditService(ctx.serverDB);
      return service.listUserTimeline({ actorUserId: ctx.userId!, input });
    }),
});
