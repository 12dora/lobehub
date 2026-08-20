import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { withScopedPermission } from '@/business/server/trpc-middlewares/rbacPermission';
import { wsCompatProcedure } from '@/business/server/trpc-middlewares/workspaceAuth';
import { MANAGED_ERROR_CODES } from '@/const/platform/errorCodes';
import { MessageModel } from '@/database/models/message';
import { ThreadModel } from '@/database/models/thread';
import { TopicModel } from '@/database/models/topic';
import type { LobeChatDatabase } from '@/database/type';
import { router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';
import { throwEnterpriseError } from '@/server/enterprise/guards/enterpriseErrors';
import { AgentService } from '@/server/services/agent';
import type { ThreadItem } from '@/types/topic/thread';
import { createThreadSchema, updateThreadSchema } from '@/types/topic/thread';
import { markdownToTxt } from '@/utils/markdownToTxt';

import { resolveAgentIdFromSession } from './_helpers/resolveContext';

/**
 * `ThreadModel.create` uses `onConflictDoNothing()` and returns undefined when
 * the inserted id collides with an existing row. With server-generated 16-char
 * nanoids this branch was effectively unreachable, but caller-provided ids
 * (used by the CC subagent executor to allocate `threadId` synchronously
 * before the create call resolves) can collide on retry or duplicate
 * submission. Translating undefined into a CONFLICT error is required to
 * avoid the downstream `messageModel.create({ threadId: undefined })` orphan
 * write the original code allowed.
 */
const ensureThreadCreated = <T extends { id: string } | undefined>(
  thread: T,
  providedId: string | undefined,
): NonNullable<T> => {
  if (thread) return thread as NonNullable<T>;
  throw new TRPCError({
    code: 'CONFLICT',
    message: providedId
      ? `Thread id collision: ${providedId}. Regenerate the id and retry.`
      : 'Thread create returned no row',
  });
};

const threadProcedure = wsCompatProcedure.use(serverDatabase).use(async (opts) => {
  const { ctx } = opts;
  const wsId = ctx.workspaceId ?? undefined;

  return opts.next({
    ctx: {
      messageModel: new MessageModel(ctx.serverDB, ctx.userId, wsId),
      threadModel: new ThreadModel(ctx.serverDB, ctx.userId, wsId),
      topicModel: new TopicModel(ctx.serverDB, ctx.userId, wsId),
    },
  });
});

const threadAgentService = (ctx: {
  serverDB: LobeChatDatabase;
  userId: string;
  workspaceId?: string | null;
}) => new AgentService(ctx.serverDB, ctx.userId, ctx.workspaceId ?? undefined);

const assertThreadTopicVisible = async (
  ctx: {
    serverDB: LobeChatDatabase;
    topicModel: TopicModel;
    userId: string;
    workspaceId?: string | null;
  },
  topicId: string,
) => {
  const visible = await threadAgentService(ctx).getTakeoverVisibleLocalAgentIds();
  if (!visible) return;

  const topic = await ctx.topicModel.findById(topicId);
  if (!topic) return;
  if (topic.groupId) return;
  if (topic.agentId) {
    await threadAgentService(ctx).assertAgentReadable(topic.agentId);
    return;
  }
  if (topic.sessionId) {
    const agentId = await resolveAgentIdFromSession(
      topic.sessionId,
      ctx.serverDB,
      ctx.userId,
      ctx.workspaceId ?? undefined,
    );
    if (agentId) {
      await threadAgentService(ctx).assertAgentReadable(agentId);
      return;
    }
  }
  throwEnterpriseError({
    code: MANAGED_ERROR_CODES.RESOURCE_MANAGED_BY_PLATFORM,
    details: { resource: 'agents' },
    httpCode: 'FORBIDDEN',
    message: MANAGED_ERROR_CODES.RESOURCE_MANAGED_BY_PLATFORM,
  });
};

export const threadRouter = router({
  createThread: threadProcedure
    .use(withScopedPermission('topic:create'))
    .input(createThreadSchema)
    .mutation(async ({ input, ctx }) => {
      const thread = ensureThreadCreated(
        await ctx.threadModel.create({
          id: input.id,
          metadata: input.metadata,
          parentThreadId: input.parentThreadId,
          sourceMessageId: input.sourceMessageId,
          title: input.title,
          topicId: input.topicId,
          type: input.type,
        }),
        input.id,
      );

      return thread.id;
    }),
  createThreadWithMessage: threadProcedure
    .use(withScopedPermission('topic:create'))
    .input(
      createThreadSchema.extend({
        message: z.any(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      return ctx.serverDB.transaction(async (trx) => {
        const thread = ensureThreadCreated(
          await ctx.threadModel.create(
            {
              id: input.id,
              metadata: input.metadata,
              parentThreadId: input.parentThreadId,
              sourceMessageId: input.sourceMessageId,
              title: markdownToTxt(input.message.content).slice(0, 80),
              topicId: input.topicId,
              type: input.type,
            },
            trx,
          ),
          input.id,
        );

        const message = await ctx.messageModel.createWithTransaction(trx, {
          ...input.message,
          threadId: thread.id,
          topicId: input.topicId,
        });

        return { messageId: message?.id, threadId: thread.id };
      });
    }),
  getThread: threadProcedure.query(async ({ ctx }): Promise<ThreadItem[]> => {
    const visible = await threadAgentService(ctx).getTakeoverVisibleLocalAgentIds();
    if (!visible) return ctx.threadModel.query() as Promise<ThreadItem[]>;
    return ctx.threadModel.query({ visibleAgentIds: [...visible] }) as Promise<ThreadItem[]>;
  }),

  getThreads: threadProcedure
    .input(z.object({ topicId: z.string() }))
    .query(async ({ input, ctx }) => {
      await assertThreadTopicVisible(ctx, input.topicId);
      return ctx.threadModel.queryByTopicId(input.topicId);
    }),

  removeAllThreads: threadProcedure
    .use(withScopedPermission('topic:delete'))
    .mutation(async ({ ctx }) => {
      return ctx.threadModel.deleteAll();
    }),

  removeThread: threadProcedure
    .use(withScopedPermission('topic:delete'))
    .input(z.object({ id: z.string(), removeChildren: z.boolean().optional() }))
    .mutation(async ({ input, ctx }) => {
      return ctx.threadModel.delete(input.id);
    }),

  updateThread: threadProcedure
    .use(withScopedPermission('topic:update'))
    .input(
      z.object({
        id: z.string(),
        value: updateThreadSchema,
      }),
    )
    .mutation(async ({ input, ctx }) => {
      return ctx.threadModel.update(input.id, input.value);
    }),
});

export type ThreadRouter = typeof threadRouter;
