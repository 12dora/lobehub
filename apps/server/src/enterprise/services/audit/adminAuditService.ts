/**
 * Admin audit A2 service layer.
 * Orchestrates policy, operation events, conversations, users, and legal holds.
 * Credential-only masking for conversation bodies; no extra read-time redaction on operation diffs.
 *
 * Split (SAO-009): conversations / users / legal holds live in sibling modules;
 * this class remains the public facade (`export * from './adminAuditService'`).
 */

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import {
  PlatformAuditConversationModel,
  PlatformAuditLegalHoldModel,
  PlatformAuditLogModel,
  PlatformAuditPolicyModel,
  PlatformRevisionConflictError,
} from '@/database/models/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import type {
  AdminAuditConversationsListInputParsed,
  AdminAuditConversationsMessagesInputParsed,
  AdminAuditEventsFacetsInputParsed,
  AdminAuditEventsListInputParsed,
  AdminAuditLegalHoldsCreateInput,
  AdminAuditLegalHoldsListInputParsed,
  AdminAuditLegalHoldsReleaseInput,
  AdminAuditPolicyUpdateInput,
  AdminAuditUsersSearchInputParsed,
  AdminAuditUsersTimelineInputParsed,
} from '../../contracts/adminAudit';
import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import { appendAuditAccessLog, buildAuditFilterSummary } from './accessLog';
import {
  getConversation,
  listConversationMessages,
  listConversations,
} from './adminAuditServiceConversations';
import type { AdminAuditServiceHost } from './adminAuditServiceHost';
import {
  createLegalHold,
  getLegalHold,
  listLegalHolds,
  releaseLegalHold,
} from './adminAuditServiceLegalHolds';
import {
  type ConversationsGetInput,
  type EventsStatsInput,
  isNotFoundError,
  toEventDetail,
  toEventListItem,
  toPolicyPublic,
} from './adminAuditServiceShared';
import { getUserSummary, listUserTimeline, searchUsers } from './adminAuditServiceUsers';
import type { AuditExportArtifactStorage } from './exportStorage';
import { resolveAuditTimeWindow } from './timeWindow';

export class AdminAuditService {
  private readonly conversationModel: PlatformAuditConversationModel;
  private readonly legalHoldModel: PlatformAuditLegalHoldModel;
  private readonly logModel: PlatformAuditLogModel;
  private readonly policyModel: PlatformAuditPolicyModel;

  constructor(private readonly db: LobeChatDatabase | Transaction) {
    this.conversationModel = new PlatformAuditConversationModel(db);
    this.legalHoldModel = new PlatformAuditLegalHoldModel(db);
    this.logModel = new PlatformAuditLogModel(db);
    this.policyModel = new PlatformAuditPolicyModel(db);
  }

  private host = (): AdminAuditServiceHost => ({
    conversationModel: this.conversationModel,
    db: this.db,
    legalHoldModel: this.legalHoldModel,
    logModel: this.logModel,
    policyModel: this.policyModel,
  });

  // ── policy ────────────────────────────────────────────────────────────────

  getPolicy = async (params: { actorUserId: string }) => {
    const filterSummary = buildAuditFilterSummary({});
    try {
      const policy = await this.policyModel.getOrCreate();
      await appendAuditAccessLog(this.db, {
        action: 'admin.audit.policy.get',
        actorUserId: params.actorUserId,
        filterSummary,
        result: 'success',
        targetId: policy.id,
        targetType: 'audit_policy',
      });
      return toPolicyPublic(policy);
    } catch (error) {
      await appendAuditAccessLog(this.db, {
        action: 'admin.audit.policy.get',
        actorUserId: params.actorUserId,
        afterDiff: { error: 'failure' },
        filterSummary,
        result: 'failure',
        targetType: 'audit_policy',
      });
      throw error;
    }
  };

  updatePolicy = async (params: { actorUserId: string; input: AdminAuditPolicyUpdateInput }) => {
    const filterSummary = buildAuditFilterSummary({});
    const before = await this.policyModel.getOrCreate();
    try {
      // Mutation + required audit append in one transaction so we never commit
      // an unaudited policy change (and never report failure after a committed mutation).
      const db = this.db as LobeChatDatabase;
      const updated = await db.transaction(async (tx) => {
        const policyModel = new PlatformAuditPolicyModel(tx);
        const next = await policyModel.updateCAS({
          contentAccessMode: params.input.contentAccessMode,
          conversationRetentionDays: params.input.conversationRetentionDays,
          expectedRevision: params.input.expectedRevision,
          exportArtifactRetentionDays: params.input.exportArtifactRetentionDays,
          maxExportRows: params.input.maxExportRows,
          maxListWindowDays: params.input.maxListWindowDays,
          messageBodyInExport: params.input.messageBodyInExport,
          operationLogRetentionDays: params.input.operationLogRetentionDays,
          redactionProfile: params.input.redactionProfile,
          updatedBy: params.actorUserId,
        });

        await appendAuditAccessLog(tx, {
          action: 'admin.audit.policy.update',
          actorUserId: params.actorUserId,
          afterDiff: {
            contentAccessMode: next.contentAccessMode,
            maxListWindowDays: next.maxListWindowDays,
            redactionProfile: next.redactionProfile,
            revision: next.revision,
          },
          beforeDiff: {
            contentAccessMode: before.contentAccessMode,
            maxListWindowDays: before.maxListWindowDays,
            redactionProfile: before.redactionProfile,
            revision: before.revision,
          },
          filterSummary,
          reason: params.input.reason,
          required: true,
          result: 'success',
          targetId: next.id,
          targetType: 'audit_policy',
        });
        return next;
      });
      return toPolicyPublic(updated);
    } catch (error) {
      if (error instanceof PlatformRevisionConflictError) {
        await appendAuditAccessLog(this.db, {
          action: 'admin.audit.policy.update',
          actorUserId: params.actorUserId,
          afterDiff: { error: 'revision_conflict' },
          filterSummary,
          reason: params.input.reason,
          result: 'failure',
          targetId: before.id,
          targetType: 'audit_policy',
        });
        return throwEnterpriseError({
          code: PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT,
          details: {
            currentRevision: error.details?.currentRevision ?? null,
            expectedRevision: params.input.expectedRevision,
          },
          httpCode: 'CONFLICT',
          message: PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT,
        });
      }
      await appendAuditAccessLog(this.db, {
        action: 'admin.audit.policy.update',
        actorUserId: params.actorUserId,
        afterDiff: { error: 'failure' },
        filterSummary,
        reason: params.input.reason,
        result: 'failure',
        targetType: 'audit_policy',
      });
      throw error;
    }
  };

  // ── events ────────────────────────────────────────────────────────────────

  listEvents = async (params: {
    accessAction?: 'admin.audit.events.list' | 'admin.audit.list';
    actorUserId: string;
    input: AdminAuditEventsListInputParsed;
  }) => {
    const accessAction = params.accessAction ?? 'admin.audit.events.list';
    const filterSummary = buildAuditFilterSummary({
      action: params.input.action,
      actions: params.input.actions,
      actorUserId: params.input.actorUserId,
      cursor: params.input.cursor,
      from: params.input.from,
      limit: params.input.limit,
      requestId: params.input.requestId,
      result: params.input.result,
      results: params.input.results,
      targetId: params.input.targetId,
      targetType: params.input.targetType,
      to: params.input.to,
    });

    try {
      const policy = await this.policyModel.getOrCreate();
      const window = resolveAuditTimeWindow({
        from: params.input.from,
        maxListWindowDays: policy.maxListWindowDays,
        to: params.input.to,
      });

      const page = await this.logModel.list({
        action: params.input.action,
        actions: params.input.actions,
        actorUserId: params.input.actorUserId,
        cursor: params.input.cursor,
        from: window.from,
        limit: params.input.limit,
        requestId: params.input.requestId,
        result: params.input.result,
        results: params.input.results,
        targetId: params.input.targetId,
        targetType: params.input.targetType,
        to: window.to,
      });

      await appendAuditAccessLog(this.db, {
        action: accessAction,
        actorUserId: params.actorUserId,
        filterSummary,
        result: 'success',
        targetType: 'audit_event',
      });

      return {
        items: page.items.map(toEventListItem),
        nextCursor: page.nextCursor,
      };
    } catch (error) {
      await appendAuditAccessLog(this.db, {
        action: accessAction,
        actorUserId: params.actorUserId,
        afterDiff: { error: 'failure' },
        filterSummary,
        result: 'failure',
        targetType: 'audit_event',
      });
      throw error;
    }
  };

  getEvent = async (params: {
    accessAction?: 'admin.audit.events.get' | 'admin.audit.get';
    actorUserId: string;
    id: string;
  }) => {
    const accessAction = params.accessAction ?? 'admin.audit.events.get';
    const filterSummary = buildAuditFilterSummary({});
    try {
      const row = await this.logModel.findById(params.id);
      if (!row) {
        await appendAuditAccessLog(this.db, {
          action: accessAction,
          actorUserId: params.actorUserId,
          afterDiff: { error: 'not_found' },
          filterSummary,
          result: 'failure',
          targetId: params.id,
          targetType: 'audit_event',
        });
        return throwEnterpriseError({
          code: PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND,
          httpCode: 'NOT_FOUND',
        });
      }

      // Event detail exposes before/after diffs — fail closed if audit cannot be recorded.
      await appendAuditAccessLog(this.db, {
        action: accessAction,
        actorUserId: params.actorUserId,
        filterSummary,
        required: true,
        result: 'success',
        targetId: params.id,
        targetType: 'audit_event',
      });

      return toEventDetail(row);
    } catch (error) {
      if (isNotFoundError(error)) throw error;
      await appendAuditAccessLog(this.db, {
        action: accessAction,
        actorUserId: params.actorUserId,
        afterDiff: { error: 'failure' },
        filterSummary,
        result: 'failure',
        targetId: params.id,
        targetType: 'audit_event',
      });
      throw error;
    }
  };

  getEventFacets = async (params: {
    actorUserId: string;
    input: AdminAuditEventsFacetsInputParsed;
  }) => {
    const filterSummary = buildAuditFilterSummary({
      from: params.input.from,
      limit: params.input.limit,
      to: params.input.to,
    });
    try {
      const policy = await this.policyModel.getOrCreate();
      const window = resolveAuditTimeWindow({
        from: params.input.from,
        maxListWindowDays: policy.maxListWindowDays,
        to: params.input.to,
      });
      const facets = await this.logModel.getFacets({
        from: window.from,
        limit: params.input.limit,
        to: window.to,
      });
      await appendAuditAccessLog(this.db, {
        action: 'admin.audit.events.facets',
        actorUserId: params.actorUserId,
        filterSummary,
        result: 'success',
        targetType: 'audit_event',
      });
      return facets;
    } catch (error) {
      await appendAuditAccessLog(this.db, {
        action: 'admin.audit.events.facets',
        actorUserId: params.actorUserId,
        afterDiff: { error: 'failure' },
        filterSummary,
        result: 'failure',
        targetType: 'audit_event',
      });
      throw error;
    }
  };

  getEventStats = async (params: { actorUserId: string; input: EventsStatsInput }) => {
    const filterSummary = buildAuditFilterSummary({
      from: params.input.from,
      to: params.input.to,
    });
    try {
      const policy = await this.policyModel.getOrCreate();
      const window = resolveAuditTimeWindow({
        from: params.input.from,
        maxListWindowDays: policy.maxListWindowDays,
        to: params.input.to,
      });
      const stats = await this.logModel.getStats({ from: window.from, to: window.to });
      await appendAuditAccessLog(this.db, {
        action: 'admin.audit.events.stats',
        actorUserId: params.actorUserId,
        filterSummary,
        result: 'success',
        targetType: 'audit_event',
      });
      return stats;
    } catch (error) {
      await appendAuditAccessLog(this.db, {
        action: 'admin.audit.events.stats',
        actorUserId: params.actorUserId,
        afterDiff: { error: 'failure' },
        filterSummary,
        result: 'failure',
        targetType: 'audit_event',
      });
      throw error;
    }
  };

  // ── conversations (delegated) ─────────────────────────────────────────────

  listConversations = async (params: {
    actorUserId: string;
    input: AdminAuditConversationsListInputParsed;
  }) => listConversations(this.host(), params);

  getConversation = async (params: { actorUserId: string; input: ConversationsGetInput }) =>
    getConversation(this.host(), params);

  listConversationMessages = async (params: {
    actorUserId: string;
    input: AdminAuditConversationsMessagesInputParsed;
  }) => listConversationMessages(this.host(), params);

  // ── users (delegated) ─────────────────────────────────────────────────────

  searchUsers = async (params: { actorUserId: string; input: AdminAuditUsersSearchInputParsed }) =>
    searchUsers(this.host(), params);

  getUserSummary = async (params: { actorUserId: string; userId: string }) =>
    getUserSummary(this.host(), params);

  listUserTimeline = async (params: {
    actorUserId: string;
    input: AdminAuditUsersTimelineInputParsed;
  }) => listUserTimeline(this.host(), params);

  // ── legal holds (delegated) ───────────────────────────────────────────────

  listLegalHolds = async (params: {
    actorUserId: string;
    input: AdminAuditLegalHoldsListInputParsed;
  }) => listLegalHolds(this.host(), params);

  getLegalHold = async (params: { actorUserId: string; id: string }) =>
    getLegalHold(this.host(), params);

  createLegalHold = async (params: {
    actorUserId: string;
    input: AdminAuditLegalHoldsCreateInput;
    storage?: AuditExportArtifactStorage;
  }) => createLegalHold(this.host(), params);

  releaseLegalHold = async (params: {
    actorUserId: string;
    input: AdminAuditLegalHoldsReleaseInput;
  }) => releaseLegalHold(this.host(), params);
}
