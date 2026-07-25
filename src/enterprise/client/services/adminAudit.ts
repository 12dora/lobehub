import type { z } from 'zod';

import { lambdaClient } from '@/libs/trpc/client';
import type {
  adminAuditConversationsGetOutputSchema,
  adminAuditConversationsListOutputSchema,
  adminAuditConversationsMessagesOutputSchema,
  adminAuditEventDetailSchema,
  adminAuditEventsFacetsOutputSchema,
  AdminAuditEventsListInput,
  adminAuditEventsListOutputSchema,
  adminAuditEventsStatsOutputSchema,
  adminAuditExportItemSchema,
  AdminAuditExportsCancelInput,
  AdminAuditExportsCreateInput,
  AdminAuditExportsDownloadInput,
  adminAuditExportsDownloadOutputSchema,
  adminAuditExportsListOutputSchema,
  adminAuditLegalHoldItemSchema,
  AdminAuditLegalHoldsCreateInput,
  adminAuditLegalHoldsListOutputSchema,
  AdminAuditLegalHoldsReleaseInput,
  adminAuditPolicyGetOutputSchema,
  AdminAuditPolicyUpdateInput,
  AdminAuditRetentionCancelInput,
  AdminAuditRetentionCreateInput,
  adminAuditRetentionCreateOutputSchema,
  adminAuditRetentionListRunsOutputSchema,
  adminAuditRetentionRunItemSchema,
  adminAuditUsersSearchOutputSchema,
  adminAuditUsersSummaryOutputSchema,
  adminAuditUsersTimelineOutputSchema,
} from '@/server/enterprise/contracts/adminAudit';

export type AdminAuditPolicy = z.infer<typeof adminAuditPolicyGetOutputSchema>;
export type AdminAuditEventsListOutput = z.infer<typeof adminAuditEventsListOutputSchema>;
export type AdminAuditEventListItem = AdminAuditEventsListOutput['items'][number];
export type AdminAuditEventDetail = z.infer<typeof adminAuditEventDetailSchema>;
export type AdminAuditEventsFacets = z.infer<typeof adminAuditEventsFacetsOutputSchema>;
export type AdminAuditEventsStats = z.infer<typeof adminAuditEventsStatsOutputSchema>;

export type AdminAuditConversationsListOutput = z.infer<
  typeof adminAuditConversationsListOutputSchema
>;
export type AdminAuditConversationListItem = AdminAuditConversationsListOutput['items'][number];
export type AdminAuditConversationDetail = z.infer<typeof adminAuditConversationsGetOutputSchema>;
export type AdminAuditConversationsMessagesOutput = z.infer<
  typeof adminAuditConversationsMessagesOutputSchema
>;
export type AdminAuditConversationMessage = AdminAuditConversationsMessagesOutput['items'][number];

export type AdminAuditUsersSearchOutput = z.infer<typeof adminAuditUsersSearchOutputSchema>;
export type AdminAuditUserSearchItem = AdminAuditUsersSearchOutput['items'][number];
export type AdminAuditUserSummary = z.infer<typeof adminAuditUsersSummaryOutputSchema>;
export type AdminAuditUsersTimelineOutput = z.infer<typeof adminAuditUsersTimelineOutputSchema>;
export type AdminAuditUsersTimelineItem = AdminAuditUsersTimelineOutput['items'][number];

export type AdminAuditLegalHoldItem = z.infer<typeof adminAuditLegalHoldItemSchema>;
export type AdminAuditLegalHoldsListOutput = z.infer<typeof adminAuditLegalHoldsListOutputSchema>;

export type AdminAuditExportItem = z.infer<typeof adminAuditExportItemSchema>;
export type AdminAuditExportsListOutput = z.infer<typeof adminAuditExportsListOutputSchema>;
export type AdminAuditExportsDownloadOutput = z.infer<typeof adminAuditExportsDownloadOutputSchema>;

export type AdminAuditRetentionRunItem = z.infer<typeof adminAuditRetentionRunItemSchema>;
export type AdminAuditRetentionCreateOutput = z.infer<typeof adminAuditRetentionCreateOutputSchema>;
export type AdminAuditRetentionListRunsOutput = z.infer<
  typeof adminAuditRetentionListRunsOutputSchema
>;

/**
 * Typed client wrappers for `admin.audit.*`.
 * Do not re-declare Zod contracts client-side — types come from the server contract.
 */
class AdminAuditService {
  // ── policy ───────────────────────────────────────────────────────────────
  getPolicy = async (): Promise<AdminAuditPolicy> => {
    return lambdaClient.admin.audit.policy.get.query();
  };

  updatePolicy = async (input: AdminAuditPolicyUpdateInput): Promise<AdminAuditPolicy> => {
    return lambdaClient.admin.audit.policy.update.mutate(input);
  };

  // ── events ───────────────────────────────────────────────────────────────
  listEvents = async (
    input: AdminAuditEventsListInput = {},
  ): Promise<AdminAuditEventsListOutput> => {
    return lambdaClient.admin.audit.events.list.query(input);
  };

  getEvent = async (input: { id: string }): Promise<AdminAuditEventDetail> => {
    return lambdaClient.admin.audit.events.get.query(input);
  };

  getEventFacets = async (
    input: {
      from?: Date;
      limit?: number;
      to?: Date;
    } = {},
  ): Promise<AdminAuditEventsFacets> => {
    return lambdaClient.admin.audit.events.facets.query(input);
  };

  getEventStats = async (
    input: {
      from?: Date;
      to?: Date;
    } = {},
  ): Promise<AdminAuditEventsStats> => {
    return lambdaClient.admin.audit.events.stats.query(input);
  };

  // ── conversations ────────────────────────────────────────────────────────
  listConversations = async (input: {
    cursor?: string;
    from?: Date;
    limit?: number;
    q?: string;
    to?: Date;
    userId: string;
  }): Promise<AdminAuditConversationsListOutput> => {
    return lambdaClient.admin.audit.conversations.list.query(input);
  };

  getConversation = async (input: {
    topicId: string;
    userId: string;
  }): Promise<AdminAuditConversationDetail> => {
    return lambdaClient.admin.audit.conversations.get.query(input);
  };

  listConversationMessages = async (input: {
    cursor?: string;
    from?: Date;
    includeBody?: boolean;
    limit?: number;
    to?: Date;
    topicId: string;
    userId: string;
  }): Promise<AdminAuditConversationsMessagesOutput> => {
    return lambdaClient.admin.audit.conversations.messages.query(input);
  };

  // ── users ────────────────────────────────────────────────────────────────
  searchUsers = async (input: {
    cursor?: string;
    limit?: number;
    q: string;
  }): Promise<AdminAuditUsersSearchOutput> => {
    return lambdaClient.admin.audit.users.search.query(input);
  };

  getUserSummary = async (input: { userId: string }): Promise<AdminAuditUserSummary> => {
    return lambdaClient.admin.audit.users.summary.query(input);
  };

  getUserTimeline = async (input: {
    cursor?: string;
    from?: Date;
    limit?: number;
    to?: Date;
    userId: string;
  }): Promise<AdminAuditUsersTimelineOutput> => {
    return lambdaClient.admin.audit.users.timeline.query(input);
  };

  // ── legal holds ──────────────────────────────────────────────────────────
  listLegalHolds = async (
    input: {
      createdBy?: string;
      cursor?: string;
      limit?: number;
      scopeId?: string | null;
      scopeType?: AdminAuditLegalHoldItem['scopeType'];
      /** Stored filter only — projected `expired` is not a list filter value. */
      status?: 'active' | 'released';
    } = {},
  ): Promise<AdminAuditLegalHoldsListOutput> => {
    return lambdaClient.admin.audit.legalHolds.list.query(input);
  };

  createLegalHold = async (
    input: AdminAuditLegalHoldsCreateInput,
  ): Promise<AdminAuditLegalHoldItem> => {
    return lambdaClient.admin.audit.legalHolds.create.mutate(input);
  };

  releaseLegalHold = async (
    input: AdminAuditLegalHoldsReleaseInput,
  ): Promise<AdminAuditLegalHoldItem> => {
    return lambdaClient.admin.audit.legalHolds.release.mutate(input);
  };

  // ── exports ──────────────────────────────────────────────────────────────
  createExport = async (input: AdminAuditExportsCreateInput): Promise<AdminAuditExportItem> => {
    return lambdaClient.admin.audit.exports.create.mutate(input);
  };

  listExports = async (
    input: {
      cursor?: string;
      kind?: AdminAuditExportItem['kind'];
      limit?: number;
      mine?: boolean;
      status?: AdminAuditExportItem['status'];
    } = {},
  ): Promise<AdminAuditExportsListOutput> => {
    return lambdaClient.admin.audit.exports.list.query(input);
  };

  downloadExport = async (
    input: AdminAuditExportsDownloadInput,
  ): Promise<AdminAuditExportsDownloadOutput> => {
    return lambdaClient.admin.audit.exports.download.mutate(input);
  };

  cancelExport = async (input: AdminAuditExportsCancelInput): Promise<AdminAuditExportItem> => {
    return lambdaClient.admin.audit.exports.cancel.mutate(input);
  };

  // ── retention ────────────────────────────────────────────────────────────
  retentionDryRun = async (
    input: AdminAuditRetentionCreateInput,
  ): Promise<AdminAuditRetentionCreateOutput> => {
    return lambdaClient.admin.audit.retention.dryRun.mutate(input);
  };

  retentionRun = async (
    input: AdminAuditRetentionCreateInput,
  ): Promise<AdminAuditRetentionCreateOutput> => {
    return lambdaClient.admin.audit.retention.run.mutate(input);
  };

  listRetentionRuns = async (
    input: {
      cursor?: string;
      limit?: number;
      mode?: AdminAuditRetentionRunItem['mode'];
      mine?: boolean;
      scope?: AdminAuditRetentionRunItem['scope'];
      status?: AdminAuditRetentionRunItem['status'];
    } = {},
  ): Promise<AdminAuditRetentionListRunsOutput> => {
    return lambdaClient.admin.audit.retention.listRuns.query(input);
  };

  cancelRetentionRun = async (
    input: AdminAuditRetentionCancelInput,
  ): Promise<AdminAuditRetentionRunItem> => {
    return lambdaClient.admin.audit.retention.cancel.mutate(input);
  };
}

export const adminAuditService = new AdminAuditService();

export type {
  AdminAuditEventsListInput,
  AdminAuditExportsCancelInput,
  AdminAuditExportsCreateInput,
  AdminAuditExportsDownloadInput,
  AdminAuditLegalHoldsCreateInput,
  AdminAuditLegalHoldsReleaseInput,
  AdminAuditPolicyUpdateInput,
  AdminAuditRetentionCancelInput,
  AdminAuditRetentionCreateInput,
};
