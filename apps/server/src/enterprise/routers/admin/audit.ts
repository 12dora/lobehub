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

import { router } from '@/libs/trpc/lambda';

import {
  adminAuditEventsGetInputSchema,
  adminAuditEventsGetOutputSchema,
  adminAuditEventsListInputSchema,
  adminAuditEventsListOutputSchema,
} from '../../contracts/adminAudit';
import { AdminAuditService } from '../../services/audit';
import { auditRead } from './audit.procedure';
import { conversationsRouter, eventsRouter, policyRouter, usersRouter } from './audit.reads';
import { exportsRouter, legalHoldsRouter, retentionRouter } from './audit.writes';

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
