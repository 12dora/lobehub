/**
 * Conversation read paths for AdminAuditService (SAO-009).
 */

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { applyAuditConversationRedaction } from '@/database/models/platform';

import type {
  AdminAuditConversationsListInputParsed,
  AdminAuditConversationsMessagesInputParsed,
} from '../../contracts/adminAudit';
import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import { appendAuditAccessLog, buildAuditFilterSummary } from './accessLog';
import {
  listConversationMessageBodies,
  listConversationMessageMetadata,
} from './adminAuditServiceConversationMessages';
import type { AdminAuditServiceHost } from './adminAuditServiceHost';
import {
  accessLogResultForError,
  type ConversationsGetInput,
  isNotFoundError,
  maskOptionalText,
} from './adminAuditServiceShared';
import type { ConversationContentAccess } from './contentPolicy';
import { assertConversationAccessEnabled, resolveConversationContentAccess } from './contentPolicy';
import { resolveAuditTimeWindow } from './timeWindow';

export const listConversations = async (
  host: AdminAuditServiceHost,
  params: {
    actorUserId: string;
    input: AdminAuditConversationsListInputParsed;
  },
) => {
  const filterSummary = buildAuditFilterSummary({
    cursor: params.input.cursor,
    from: params.input.from,
    hasQ: Boolean(params.input.q),
    limit: params.input.limit,
    to: params.input.to,
    userId: params.input.userId,
  });
  try {
    const policy = await host.policyModel.getOrCreate();
    assertConversationAccessEnabled(policy.contentAccessMode);
    const window = resolveAuditTimeWindow({
      from: params.input.from,
      maxListWindowDays: policy.maxListWindowDays,
      to: params.input.to,
    });

    const page = await host.conversationModel.listTopics({
      cursor: params.input.cursor,
      from: window.from,
      limit: params.input.limit,
      q: params.input.q,
      to: window.to,
      userId: params.input.userId,
    });

    const items = page.items.map((row) => ({
      ...row,
      description: maskOptionalText(row.description, policy.redactionProfile) ?? null,
      title: maskOptionalText(row.title, policy.redactionProfile) ?? null,
    }));

    await appendAuditAccessLog(host.db, {
      action: 'admin.audit.conversations.list',
      actorUserId: params.actorUserId,
      filterSummary,
      result: 'success',
      targetId: params.input.userId,
      targetType: 'user',
    });
    return { items, nextCursor: page.nextCursor, redactionProfile: policy.redactionProfile };
  } catch (error) {
    await appendAuditAccessLog(host.db, {
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

type ConversationPolicy = Awaited<ReturnType<AdminAuditServiceHost['policyModel']['getOrCreate']>>;
type ConversationTopic = NonNullable<
  Awaited<ReturnType<AdminAuditServiceHost['conversationModel']['getTopic']>>
>;

const toConversationGetResult = (
  topic: ConversationTopic,
  access: ConversationContentAccess,
  redactionProfile: ConversationPolicy['redactionProfile'],
) => {
  const base = {
    agentId: topic.agentId,
    contentAccessMode: access.mode,
    createdAt: topic.createdAt,
    description: maskOptionalText(topic.description, redactionProfile) ?? null,
    id: topic.id,
    model: topic.model,
    provider: topic.provider,
    redactionProfile,
    sessionId: topic.sessionId,
    status: topic.status,
    title: maskOptionalText(topic.title, redactionProfile) ?? null,
    updatedAt: topic.updatedAt,
    userId: topic.userId,
  };

  return access.allowBody
    ? {
        ...base,
        content:
          topic.content == null
            ? null
            : applyAuditConversationRedaction(topic.content, redactionProfile),
        editorData:
          topic.editorData == null
            ? undefined
            : applyAuditConversationRedaction(topic.editorData, redactionProfile),
        historySummary:
          topic.historySummary == null
            ? null
            : applyAuditConversationRedaction(topic.historySummary, redactionProfile),
      }
    : base;
};

export const getConversation = async (
  host: AdminAuditServiceHost,
  params: { actorUserId: string; input: ConversationsGetInput },
) => {
  const filterSummary = buildAuditFilterSummary({
    topicId: params.input.topicId,
    userId: params.input.userId,
  });
  try {
    const policy = await host.policyModel.getOrCreate();
    assertConversationAccessEnabled(policy.contentAccessMode);
    const access = resolveConversationContentAccess(policy.contentAccessMode);

    const topic = await host.conversationModel.getTopic({
      topicId: params.input.topicId,
      userId: params.input.userId,
    });
    if (!topic) {
      await appendAuditAccessLog(host.db, {
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

    const result = toConversationGetResult(topic, access, policy.redactionProfile);

    // Body-bearing conversation reads are sensitive — fail closed on audit failure.
    await appendAuditAccessLog(host.db, {
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
    await appendAuditAccessLog(host.db, {
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

export const listConversationMessages = async (
  host: AdminAuditServiceHost,
  params: {
    actorUserId: string;
    input: AdminAuditConversationsMessagesInputParsed;
  },
) => {
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
    const policy = await host.policyModel.getOrCreate();
    assertConversationAccessEnabled(policy.contentAccessMode);
    const access = resolveConversationContentAccess(policy.contentAccessMode);
    const window = resolveAuditTimeWindow({
      from: params.input.from,
      maxListWindowDays: policy.maxListWindowDays,
      to: params.input.to,
    });

    const wantBody = Boolean(params.input.includeBody) && access.allowBody;
    const ctx = {
      access,
      actorUserId: params.actorUserId,
      filterSummary,
      host,
      input: params.input,
      redactionProfile: policy.redactionProfile,
      window,
    };

    if (wantBody) {
      return listConversationMessageBodies(ctx);
    }

    return listConversationMessageMetadata(ctx);
  } catch (error) {
    await appendAuditAccessLog(host.db, {
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
