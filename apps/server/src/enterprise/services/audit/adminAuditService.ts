/**
 * Admin audit A2 service layer.
 * Orchestrates policy, operation events, conversations, users, and legal holds.
 * Credential-only masking for conversation bodies; no extra read-time redaction on operation diffs.
 */

import { ADMIN_ERROR_CODES, PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import {
  maskAuditConversationEvidence,
  PlatformAuditConversationModel,
  type PlatformAuditLegalHoldItem,
  PlatformAuditLegalHoldModel,
  type PlatformAuditLogItem,
  PlatformAuditLogModel,
  type PlatformAuditPolicyItem,
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
import { getEnterpriseErrorBody, throwEnterpriseError } from '../../guards/enterpriseErrors';
import { appendAuditAccessLog, buildAuditFilterSummary } from './accessLog';
import { assertConversationAccessEnabled, resolveConversationContentAccess } from './contentPolicy';
import { resolveAuditTimeWindow } from './timeWindow';

type ConversationsGetInput = { topicId: string; userId: string };
type EventsStatsInput = { from?: Date; to?: Date };

const toPolicyPublic = (policy: PlatformAuditPolicyItem) => ({
  contentAccessMode: policy.contentAccessMode,
  conversationRetentionDays: policy.conversationRetentionDays,
  createdAt: policy.createdAt,
  exportArtifactRetentionDays: policy.exportArtifactRetentionDays,
  id: policy.id,
  maxExportRows: policy.maxExportRows,
  maxListWindowDays: policy.maxListWindowDays,
  messageBodyInExport: policy.messageBodyInExport,
  operationLogRetentionDays: policy.operationLogRetentionDays,
  redactionProfile: policy.redactionProfile,
  revision: policy.revision,
  updatedAt: policy.updatedAt,
  updatedBy: policy.updatedBy,
});

const toEventListItem = (row: PlatformAuditLogItem) => ({
  action: row.action,
  actorUserId: row.actorUserId,
  configRevision: row.configRevision,
  createdAt: row.createdAt,
  id: row.id,
  ipHash: row.ipHash,
  reason: row.reason,
  requestId: row.requestId,
  result: row.result,
  targetId: row.targetId,
  targetType: row.targetType,
  userAgent: row.userAgent,
});

/** Detail: stored diffs as-is (write-time redaction only — no extra read-time pass). */
const toEventDetail = (row: PlatformAuditLogItem) => ({
  ...toEventListItem(row),
  afterDiff: row.afterDiff,
  beforeDiff: row.beforeDiff,
});

/**
 * Project elapsed holds as `expired` even while the stored row is still `active`.
 * Retention's listActive() already excludes past-expiry holds; the admin API must
 * not present them as actionable/active.
 */
const effectiveLegalHoldStatus = (
  row: PlatformAuditLegalHoldItem,
  now: Date = new Date(),
): 'active' | 'released' | 'expired' => {
  if (row.status === 'released') return 'released';
  if (row.expiresAt != null && row.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'active';
};

const toLegalHoldPublic = (row: PlatformAuditLegalHoldItem, now: Date = new Date()) => ({
  createdAt: row.createdAt,
  createdBy: row.createdBy,
  expiresAt: row.expiresAt,
  id: row.id,
  reason: row.reason,
  releaseReason: row.releaseReason,
  releasedAt: row.releasedAt,
  releasedBy: row.releasedBy,
  scopeId: row.scopeId,
  scopeType: row.scopeType,
  status: effectiveLegalHoldStatus(row, now),
  updatedAt: row.updatedAt,
});

const isNotFoundError = (error: unknown): boolean =>
  getEnterpriseErrorBody(error)?.code === PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND;

/** Policy / feature denials that must self-audit as `denied` (not `failure`). */
const isDeniedError = (error: unknown): boolean => {
  const code = getEnterpriseErrorBody(error)?.code;
  return (
    code === PLATFORM_ERROR_CODES.PLATFORM_FEATURE_DISABLED ||
    code === PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED ||
    code === ADMIN_ERROR_CODES.ADMIN_ACCESS_DENIED ||
    code === ADMIN_ERROR_CODES.ADMIN_FEATURE_DISABLED ||
    code === ADMIN_ERROR_CODES.ADMIN_REAUTH_REQUIRED
  );
};

const accessLogResultForError = (error: unknown): 'denied' | 'failure' =>
  isDeniedError(error) ? 'denied' : 'failure';

/** Credential-mask free-text metadata that may contain pasted secrets. */
const maskOptionalText = (value: string | null | undefined): string | null | undefined => {
  if (value == null) return value;
  return maskAuditConversationEvidence(value);
};

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
            revision: next.revision,
          },
          beforeDiff: {
            contentAccessMode: before.contentAccessMode,
            maxListWindowDays: before.maxListWindowDays,
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

  // ── conversations ─────────────────────────────────────────────────────────

  listConversations = async (params: {
    actorUserId: string;
    input: AdminAuditConversationsListInputParsed;
  }) => {
    const filterSummary = buildAuditFilterSummary({
      cursor: params.input.cursor,
      from: params.input.from,
      hasQ: Boolean(params.input.q),
      limit: params.input.limit,
      to: params.input.to,
      userId: params.input.userId,
    });
    try {
      const policy = await this.policyModel.getOrCreate();
      assertConversationAccessEnabled(policy.contentAccessMode);
      const window = resolveAuditTimeWindow({
        from: params.input.from,
        maxListWindowDays: policy.maxListWindowDays,
        to: params.input.to,
      });

      const page = await this.conversationModel.listTopics({
        cursor: params.input.cursor,
        from: window.from,
        limit: params.input.limit,
        q: params.input.q,
        to: window.to,
        userId: params.input.userId,
      });

      const items = page.items.map((row) => ({
        ...row,
        description: maskOptionalText(row.description) ?? null,
        title: maskOptionalText(row.title) ?? null,
      }));

      await appendAuditAccessLog(this.db, {
        action: 'admin.audit.conversations.list',
        actorUserId: params.actorUserId,
        filterSummary,
        result: 'success',
        targetId: params.input.userId,
        targetType: 'user',
      });
      return { items, nextCursor: page.nextCursor };
    } catch (error) {
      await appendAuditAccessLog(this.db, {
        action: 'admin.audit.conversations.list',
        actorUserId: params.actorUserId,
        afterDiff: {
          error: accessLogResultForError(error) === 'denied' ? 'content_access_denied' : 'failure',
        },
        filterSummary,
        result: accessLogResultForError(error),
        targetId: params.input.userId,
        targetType: 'user',
      });
      throw error;
    }
  };

  getConversation = async (params: { actorUserId: string; input: ConversationsGetInput }) => {
    const filterSummary = buildAuditFilterSummary({
      topicId: params.input.topicId,
      userId: params.input.userId,
    });
    try {
      const policy = await this.policyModel.getOrCreate();
      assertConversationAccessEnabled(policy.contentAccessMode);
      const access = resolveConversationContentAccess(policy.contentAccessMode);

      const topic = await this.conversationModel.getTopic({
        topicId: params.input.topicId,
        userId: params.input.userId,
      });
      if (!topic) {
        await appendAuditAccessLog(this.db, {
          action: 'admin.audit.conversations.get',
          actorUserId: params.actorUserId,
          afterDiff: { error: 'not_found' },
          filterSummary,
          result: 'failure',
          targetId: params.input.topicId,
          targetType: 'topic',
        });
        return throwEnterpriseError({
          code: PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND,
          httpCode: 'NOT_FOUND',
        });
      }

      const base = {
        agentId: topic.agentId,
        contentAccessMode: access.mode,
        createdAt: topic.createdAt,
        description: maskOptionalText(topic.description) ?? null,
        id: topic.id,
        model: topic.model,
        provider: topic.provider,
        sessionId: topic.sessionId,
        status: topic.status,
        title: maskOptionalText(topic.title) ?? null,
        updatedAt: topic.updatedAt,
        userId: topic.userId,
      };

      const result = access.allowBody
        ? {
            ...base,
            content: topic.content == null ? null : maskAuditConversationEvidence(topic.content),
            editorData:
              topic.editorData == null
                ? undefined
                : maskAuditConversationEvidence(topic.editorData),
            historySummary:
              topic.historySummary == null
                ? null
                : maskAuditConversationEvidence(topic.historySummary),
          }
        : base;

      // Body-bearing conversation reads are sensitive — fail closed on audit failure.
      await appendAuditAccessLog(this.db, {
        action: 'admin.audit.conversations.get',
        actorUserId: params.actorUserId,
        filterSummary,
        required: access.allowBody,
        result: 'success',
        targetId: params.input.topicId,
        targetType: 'topic',
      });
      return result;
    } catch (error) {
      if (isNotFoundError(error)) throw error;
      await appendAuditAccessLog(this.db, {
        action: 'admin.audit.conversations.get',
        actorUserId: params.actorUserId,
        afterDiff: {
          error: accessLogResultForError(error) === 'denied' ? 'content_access_denied' : 'failure',
        },
        filterSummary,
        result: accessLogResultForError(error),
        targetId: params.input.topicId,
        targetType: 'topic',
      });
      throw error;
    }
  };

  listConversationMessages = async (params: {
    actorUserId: string;
    input: AdminAuditConversationsMessagesInputParsed;
  }) => {
    const filterSummary = buildAuditFilterSummary({
      cursor: params.input.cursor,
      from: params.input.from,
      includeBody: params.input.includeBody,
      limit: params.input.limit,
      to: params.input.to,
      topicId: params.input.topicId,
      userId: params.input.userId,
    });
    try {
      const policy = await this.policyModel.getOrCreate();
      assertConversationAccessEnabled(policy.contentAccessMode);
      const access = resolveConversationContentAccess(policy.contentAccessMode);
      const window = resolveAuditTimeWindow({
        from: params.input.from,
        maxListWindowDays: policy.maxListWindowDays,
        to: params.input.to,
      });

      const wantBody = Boolean(params.input.includeBody) && access.allowBody;

      if (wantBody) {
        const page = await this.conversationModel.listMessageDetails({
          cursor: params.input.cursor,
          from: window.from,
          limit: params.input.limit,
          to: window.to,
          topicId: params.input.topicId,
          userId: params.input.userId,
        });

        // Message bodies are sensitive evidence — never return them unaudited.
        await appendAuditAccessLog(this.db, {
          action: 'admin.audit.conversations.messages',
          actorUserId: params.actorUserId,
          filterSummary,
          required: true,
          result: 'success',
          targetId: params.input.topicId,
          targetType: 'topic',
        });

        return {
          contentAccessMode: access.mode,
          items: page.items.map((row) => ({
            agentId: row.agentId,
            content: row.content == null ? null : maskAuditConversationEvidence(row.content),
            contentAccessMode: access.mode,
            createdAt: row.createdAt,
            editorData:
              row.editorData == null ? null : maskAuditConversationEvidence(row.editorData),
            error: row.error == null ? null : maskAuditConversationEvidence(row.error),
            id: row.id,
            model: row.model,
            parentId: row.parentId,
            provider: row.provider,
            role: row.role,
            sessionId: row.sessionId,
            topicId: row.topicId,
            updatedAt: row.updatedAt,
            userId: row.userId,
          })),
          nextCursor: page.nextCursor,
        };
      }

      const page = await this.conversationModel.listMessages({
        cursor: params.input.cursor,
        from: window.from,
        limit: params.input.limit,
        to: window.to,
        topicId: params.input.topicId,
        userId: params.input.userId,
      });

      await appendAuditAccessLog(this.db, {
        action: 'admin.audit.conversations.messages',
        actorUserId: params.actorUserId,
        filterSummary,
        result: 'success',
        targetId: params.input.topicId,
        targetType: 'topic',
      });

      return {
        contentAccessMode: access.mode,
        items: page.items.map((row) => ({
          ...row,
          contentAccessMode: access.mode,
        })),
        nextCursor: page.nextCursor,
      };
    } catch (error) {
      await appendAuditAccessLog(this.db, {
        action: 'admin.audit.conversations.messages',
        actorUserId: params.actorUserId,
        afterDiff: {
          error: accessLogResultForError(error) === 'denied' ? 'content_access_denied' : 'failure',
        },
        filterSummary,
        result: accessLogResultForError(error),
        targetId: params.input.topicId,
        targetType: 'topic',
      });
      throw error;
    }
  };

  // ── users ─────────────────────────────────────────────────────────────────

  searchUsers = async (params: {
    actorUserId: string;
    input: AdminAuditUsersSearchInputParsed;
  }) => {
    const filterSummary = buildAuditFilterSummary({
      cursor: params.input.cursor,
      hasQ: true,
      limit: params.input.limit,
    });
    try {
      const page = await this.conversationModel.searchUsers({
        cursor: params.input.cursor,
        limit: params.input.limit,
        q: params.input.q,
      });
      await appendAuditAccessLog(this.db, {
        action: 'admin.audit.users.search',
        actorUserId: params.actorUserId,
        filterSummary,
        result: 'success',
        targetType: 'user',
      });
      return page;
    } catch (error) {
      await appendAuditAccessLog(this.db, {
        action: 'admin.audit.users.search',
        actorUserId: params.actorUserId,
        afterDiff: { error: 'failure' },
        filterSummary,
        result: 'failure',
        targetType: 'user',
      });
      throw error;
    }
  };

  getUserSummary = async (params: { actorUserId: string; userId: string }) => {
    const filterSummary = buildAuditFilterSummary({ userId: params.userId });
    try {
      const summary = await this.conversationModel.getUserSummary(params.userId);
      if (!summary) {
        await appendAuditAccessLog(this.db, {
          action: 'admin.audit.users.summary',
          actorUserId: params.actorUserId,
          afterDiff: { error: 'not_found' },
          filterSummary,
          result: 'failure',
          targetId: params.userId,
          targetType: 'user',
        });
        return throwEnterpriseError({
          code: PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND,
          httpCode: 'NOT_FOUND',
        });
      }
      await appendAuditAccessLog(this.db, {
        action: 'admin.audit.users.summary',
        actorUserId: params.actorUserId,
        filterSummary,
        result: 'success',
        targetId: params.userId,
        targetType: 'user',
      });
      return summary;
    } catch (error) {
      if (isNotFoundError(error)) throw error;
      await appendAuditAccessLog(this.db, {
        action: 'admin.audit.users.summary',
        actorUserId: params.actorUserId,
        afterDiff: { error: 'failure' },
        filterSummary,
        result: 'failure',
        targetId: params.userId,
        targetType: 'user',
      });
      throw error;
    }
  };

  listUserTimeline = async (params: {
    actorUserId: string;
    input: AdminAuditUsersTimelineInputParsed;
  }) => {
    const filterSummary = buildAuditFilterSummary({
      cursor: params.input.cursor,
      from: params.input.from,
      limit: params.input.limit,
      to: params.input.to,
      userId: params.input.userId,
    });
    try {
      const policy = await this.policyModel.getOrCreate();
      assertConversationAccessEnabled(policy.contentAccessMode);
      const window = resolveAuditTimeWindow({
        from: params.input.from,
        maxListWindowDays: policy.maxListWindowDays,
        to: params.input.to,
      });
      const page = await this.conversationModel.listUserTimeline({
        cursor: params.input.cursor,
        from: window.from,
        limit: params.input.limit,
        to: window.to,
        userId: params.input.userId,
      });
      const items = page.items.map((row) => ({
        ...row,
        title: maskOptionalText(row.title) ?? null,
      }));
      await appendAuditAccessLog(this.db, {
        action: 'admin.audit.users.timeline',
        actorUserId: params.actorUserId,
        filterSummary,
        result: 'success',
        targetId: params.input.userId,
        targetType: 'user',
      });
      return { items, nextCursor: page.nextCursor };
    } catch (error) {
      await appendAuditAccessLog(this.db, {
        action: 'admin.audit.users.timeline',
        actorUserId: params.actorUserId,
        afterDiff: { error: 'failure' },
        filterSummary,
        result: 'failure',
        targetId: params.input.userId,
        targetType: 'user',
      });
      throw error;
    }
  };

  // ── legal holds ───────────────────────────────────────────────────────────

  listLegalHolds = async (params: {
    actorUserId: string;
    input: AdminAuditLegalHoldsListInputParsed;
  }) => {
    const filterSummary = buildAuditFilterSummary({
      cursor: params.input.cursor,
      limit: params.input.limit,
      scopeType: params.input.scopeType,
    });
    try {
      const page = await this.legalHoldModel.list({
        createdBy: params.input.createdBy,
        cursor: params.input.cursor,
        limit: params.input.limit,
        scopeId: params.input.scopeId,
        scopeType: params.input.scopeType,
        status: params.input.status,
      });
      await appendAuditAccessLog(this.db, {
        action: 'admin.audit.legalHolds.list',
        actorUserId: params.actorUserId,
        filterSummary,
        result: 'success',
        targetType: 'legal_hold',
      });
      return {
        // Explicit row callback — map would pass index as the second arg (`now`).
        items: page.items.map((row) => toLegalHoldPublic(row)),
        nextCursor: page.nextCursor,
      };
    } catch (error) {
      await appendAuditAccessLog(this.db, {
        action: 'admin.audit.legalHolds.list',
        actorUserId: params.actorUserId,
        afterDiff: { error: 'failure' },
        filterSummary,
        result: 'failure',
        targetType: 'legal_hold',
      });
      throw error;
    }
  };

  getLegalHold = async (params: { actorUserId: string; id: string }) => {
    const filterSummary = buildAuditFilterSummary({});
    try {
      const row = await this.legalHoldModel.get(params.id);
      if (!row) {
        await appendAuditAccessLog(this.db, {
          action: 'admin.audit.legalHolds.get',
          actorUserId: params.actorUserId,
          afterDiff: { error: 'not_found' },
          filterSummary,
          result: 'failure',
          targetId: params.id,
          targetType: 'legal_hold',
        });
        return throwEnterpriseError({
          code: PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND,
          httpCode: 'NOT_FOUND',
        });
      }
      await appendAuditAccessLog(this.db, {
        action: 'admin.audit.legalHolds.get',
        actorUserId: params.actorUserId,
        filterSummary,
        result: 'success',
        targetId: params.id,
        targetType: 'legal_hold',
      });
      return toLegalHoldPublic(row);
    } catch (error) {
      if (isNotFoundError(error)) throw error;
      await appendAuditAccessLog(this.db, {
        action: 'admin.audit.legalHolds.get',
        actorUserId: params.actorUserId,
        afterDiff: { error: 'failure' },
        filterSummary,
        result: 'failure',
        targetId: params.id,
        targetType: 'legal_hold',
      });
      throw error;
    }
  };

  createLegalHold = async (params: {
    actorUserId: string;
    input: AdminAuditLegalHoldsCreateInput;
  }) => {
    const filterSummary = buildAuditFilterSummary({
      scopeType: params.input.scopeType,
    });
    try {
      // Reject non-future expiry so the UI cannot show "active" holds that
      // retention's listActive() already treats as expired.
      if (params.input.expiresAt != null) {
        const expiresMs = params.input.expiresAt.getTime();
        if (Number.isNaN(expiresMs) || expiresMs <= Date.now()) {
          return throwEnterpriseError({
            code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
            details: { reason: 'expires_at_must_be_future' },
            httpCode: 'BAD_REQUEST',
            // Stable code as message — clients localize via details.reason / code.
            message: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
          });
        }
      }

      const db = this.db as LobeChatDatabase;
      const row = await db.transaction(async (tx) => {
        const legalHoldModel = new PlatformAuditLegalHoldModel(tx);
        const created = await legalHoldModel.create({
          createdBy: params.actorUserId,
          expiresAt: params.input.expiresAt,
          reason: params.input.reason,
          scopeId: params.input.scopeId,
          scopeType: params.input.scopeType,
        });
        await appendAuditAccessLog(tx, {
          action: 'admin.audit.legalHolds.create',
          actorUserId: params.actorUserId,
          afterDiff: {
            scopeIdPresent: params.input.scopeId != null,
            scopeType: created.scopeType,
            status: created.status,
          },
          filterSummary,
          reason: params.input.reason,
          required: true,
          result: 'success',
          targetId: created.id,
          targetType: 'legal_hold',
        });
        return created;
      });
      return toLegalHoldPublic(row);
    } catch (error) {
      await appendAuditAccessLog(this.db, {
        action: 'admin.audit.legalHolds.create',
        actorUserId: params.actorUserId,
        afterDiff: { error: 'failure' },
        filterSummary,
        reason: params.input.reason,
        result: 'failure',
        targetType: 'legal_hold',
      });
      throw error;
    }
  };

  releaseLegalHold = async (params: {
    actorUserId: string;
    input: AdminAuditLegalHoldsReleaseInput;
  }) => {
    const filterSummary = buildAuditFilterSummary({});
    try {
      const db = this.db as LobeChatDatabase;
      const row = await db.transaction(async (tx) => {
        const legalHoldModel = new PlatformAuditLegalHoldModel(tx);
        const released = await legalHoldModel.release(params.input.id, {
          releasedBy: params.actorUserId,
          releaseReason: params.input.releaseReason,
        });
        if (!released) return null;
        await appendAuditAccessLog(tx, {
          action: 'admin.audit.legalHolds.release',
          actorUserId: params.actorUserId,
          afterDiff: { status: released.status },
          filterSummary,
          reason: params.input.releaseReason,
          required: true,
          result: 'success',
          targetId: released.id,
          targetType: 'legal_hold',
        });
        return released;
      });
      if (!row) {
        await appendAuditAccessLog(this.db, {
          action: 'admin.audit.legalHolds.release',
          actorUserId: params.actorUserId,
          afterDiff: { error: 'not_found' },
          filterSummary,
          reason: params.input.releaseReason,
          result: 'failure',
          targetId: params.input.id,
          targetType: 'legal_hold',
        });
        return throwEnterpriseError({
          code: PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND,
          httpCode: 'NOT_FOUND',
        });
      }
      return toLegalHoldPublic(row);
    } catch (error) {
      if (isNotFoundError(error)) throw error;
      await appendAuditAccessLog(this.db, {
        action: 'admin.audit.legalHolds.release',
        actorUserId: params.actorUserId,
        afterDiff: { error: 'failure' },
        filterSummary,
        reason: params.input.releaseReason,
        result: 'failure',
        targetId: params.input.id,
        targetType: 'legal_hold',
      });
      throw error;
    }
  };
}
