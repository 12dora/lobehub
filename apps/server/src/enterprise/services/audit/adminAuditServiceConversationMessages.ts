/**
 * Conversation message list branches for AdminAuditService (body vs metadata).
 * Body-bearing reads append a required access log before returning evidence.
 */

import { applyAuditConversationRedaction } from '@/database/models/platform';

import type { AdminAuditConversationsMessagesInputParsed } from '../../contracts/adminAudit';
import { appendAuditAccessLog } from './accessLog';
import type { AdminAuditServiceHost } from './adminAuditServiceHost';
import type { ConversationContentAccess } from './contentPolicy';

type ConversationPolicy = Awaited<ReturnType<AdminAuditServiceHost['policyModel']['getOrCreate']>>;

type MessageListContext = {
  access: ConversationContentAccess;
  actorUserId: string;
  filterSummary: NonNullable<Parameters<typeof appendAuditAccessLog>[1]['filterSummary']>;
  host: AdminAuditServiceHost;
  input: AdminAuditConversationsMessagesInputParsed;
  redactionProfile: ConversationPolicy['redactionProfile'];
  window: { from: Date; to: Date };
};

export const listConversationMessageBodies = async (ctx: MessageListContext) => {
  const page = await ctx.host.conversationModel.listMessageDetails({
    cursor: ctx.input.cursor,
    from: ctx.window.from,
    limit: ctx.input.limit,
    to: ctx.window.to,
    topicId: ctx.input.topicId,
    userId: ctx.input.userId,
  });

  // Message bodies are sensitive evidence — never return them unaudited.
  await appendAuditAccessLog(ctx.host.db, {
    action: 'admin.audit.conversations.messages',
    actorUserId: ctx.actorUserId,
    filterSummary: ctx.filterSummary,
    required: true,
    result: 'success',
    targetId: ctx.input.topicId,
    targetType: 'topic',
  });

  return {
    contentAccessMode: ctx.access.mode,
    redactionProfile: ctx.redactionProfile,
    items: page.items.map((row) => ({
      agentId: row.agentId,
      content:
        row.content == null
          ? null
          : applyAuditConversationRedaction(row.content, ctx.redactionProfile),
      contentAccessMode: ctx.access.mode,
      createdAt: row.createdAt,
      editorData:
        row.editorData == null
          ? null
          : applyAuditConversationRedaction(row.editorData, ctx.redactionProfile),
      error:
        row.error == null ? null : applyAuditConversationRedaction(row.error, ctx.redactionProfile),
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
};

export const listConversationMessageMetadata = async (ctx: MessageListContext) => {
  const page = await ctx.host.conversationModel.listMessages({
    cursor: ctx.input.cursor,
    from: ctx.window.from,
    limit: ctx.input.limit,
    to: ctx.window.to,
    topicId: ctx.input.topicId,
    userId: ctx.input.userId,
  });

  await appendAuditAccessLog(ctx.host.db, {
    action: 'admin.audit.conversations.messages',
    actorUserId: ctx.actorUserId,
    filterSummary: ctx.filterSummary,
    result: 'success',
    targetId: ctx.input.topicId,
    targetType: 'topic',
  });

  return {
    contentAccessMode: ctx.access.mode,
    items: page.items.map((row) => ({
      ...row,
      contentAccessMode: ctx.access.mode,
    })),
    nextCursor: page.nextCursor,
    redactionProfile: ctx.redactionProfile,
  };
};
