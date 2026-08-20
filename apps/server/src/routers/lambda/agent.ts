import { BUILTIN_AGENT_SLUGS } from '@lobechat/builtin-agents';
import { DEFAULT_AGENT_CONFIG, INBOX_SESSION_ID } from '@lobechat/const';
import { CreateAgentSchema, decodePlatformAgentListId, type KnowledgeItem } from '@lobechat/types';
import { KnowledgeType } from '@lobechat/types';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { withScopedPermission } from '@/business/server/trpc-middlewares/rbacPermission';
import { wsCompatProcedure } from '@/business/server/trpc-middlewares/workspaceAuth';
import { AgentModel } from '@/database/models/agent';
import { ChatGroupModel } from '@/database/models/chatGroup';
import { FileModel } from '@/database/models/file';
import { KnowledgeBaseModel } from '@/database/models/knowledgeBase';
import { SessionModel } from '@/database/models/session';
import { TaskModel } from '@/database/models/task';
import { UserModel } from '@/database/models/user';
import { router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';
import { withActiveUserWhenManagedAgents } from '@/server/enterprise/guards/activeUser';
import {
  pickAgentId,
  pickId,
  withManagedLocalAgentGuard,
} from '@/server/enterprise/guards/managedPlatformAgent';
import { withManagedResourceGuard } from '@/server/enterprise/guards/managedResource';
import {
  assertLocalAgentReadableUnderTakeover,
  isPlatformAgentTakeoverActive,
  PlatformAgentEffectiveResolver,
  PlatformAgentUserListService,
} from '@/server/enterprise/services/agentCatalog';
import { AgentService } from '@/server/services/agent';
import { EditLockService } from '@/server/services/editLock';
import { publishResourceEvent } from '@/server/services/resourceEvents';
import { hasWorkspaceScopedPermission } from '@/server/services/workspacePermission';
import { TransferErrorCode } from '@/types/transferError';

const agentProcedure = wsCompatProcedure.use(serverDatabase).use(async (opts) => {
  const { ctx } = opts;
  const wsId = ctx.workspaceId ?? undefined;

  return opts.next({
    ctx: {
      agentModel: new AgentModel(ctx.serverDB, ctx.userId, wsId),
      agentService: new AgentService(ctx.serverDB, ctx.userId, wsId),
      chatGroupModel: new ChatGroupModel(ctx.serverDB, ctx.userId, wsId),
      editLockService: new EditLockService(ctx.userId),
      fileModel: new FileModel(ctx.serverDB, ctx.userId, wsId),
      knowledgeBaseModel: new KnowledgeBaseModel(ctx.serverDB, ctx.userId, wsId),
      sessionModel: new SessionModel(ctx.serverDB, ctx.userId, wsId),
    },
  });
});

export const agentRouter = router({
  /**
   * Check if an agent with the given marketIdentifier already exists
   */
  checkByMarketIdentifier: agentProcedure
    .input(
      z.object({
        marketIdentifier: z.string(),
      }),
    )
    .query(async ({ input, ctx }) => {
      return ctx.agentModel.checkByMarketIdentifier(input.marketIdentifier);
    }),

  /**
   * Count non-virtual agents with optional keyword filter, matching the
   * conditions of queryAgents. Lets paginated callers report real totals.
   */
  countAgents: agentProcedure
    .use(withActiveUserWhenManagedAgents())
    .input(
      z
        .object({
          endDate: z.string().optional(),
          keyword: z.string().optional(),
          range: z.tuple([z.string(), z.string()]).optional(),
          startDate: z.string().optional(),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      if (await isPlatformAgentTakeoverActive(ctx.serverDB)) {
        return ctx.agentService.countAvailableAgents(input?.keyword);
      }
      return ctx.agentModel.countAgents(input);
    }),

  /**
   * Create a new agent with session
   * Returns the created agent ID and session ID
   */
  createAgent: agentProcedure
    .use(withScopedPermission('agent:create'))
    .use(withManagedResourceGuard('agent.createAgent'))
    .input(
      z.object({
        config: CreateAgentSchema.optional(),
        groupId: z.string().optional(),
        visibility: z.enum(['private', 'public']).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const agent = await ctx.agentModel.create({
        ...input.config,
        // The DB-layer AgentItem (packages/database/src/schemas/agent.ts) is
        // intentionally still typed `plugins?: string[]` — the JSONB column
        // itself isn't widened, only the domain-level `@lobechat/types`
        // shapes. Bridges the tri-state object shape through.
        plugins: input.config?.plugins as unknown as string[] | undefined,
        sessionGroupId: input.groupId,
        // Router-level `visibility` wins over any nested config value so the
        // sidebar's "Create in Private" entry can't be overridden by a stale
        // default config.
        ...(input.visibility ? { visibility: input.visibility } : {}),
      });

      return { agentId: agent.id };
    }),

  /**
   * Publish a private agent into the workspace. Only the creator of a
   * still-private agent can run this; the underlying SQL enforces both rules.
   * The inverse transition (public → private) goes through
   * `setAgentVisibility`, which is gated to the creator or a workspace owner.
   */
  publishAgentToWorkspace: agentProcedure
    .use(withScopedPermission('agent:update'))
    .use(withManagedResourceGuard('agent.publishAgentToWorkspace'))
    .use(withManagedLocalAgentGuard(pickId))
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      return ctx.agentModel.publishToWorkspace(input.id);
    }),

  /**
   * Bidirectional visibility switch (LOBE-11551). Rules:
   * - builtin agents (LobeAI etc., identified by slug) can never change
   *   visibility — the workspace copy must stay shared;
   * - only the agent's creator or a workspace owner may pull a published
   *   agent back to private; other members get FORBIDDEN. The UI hides the
   *   entry for them, this is the server-side backstop.
   */
  setAgentVisibility: agentProcedure
    .use(withScopedPermission('agent:update'))
    .use(withManagedResourceGuard('agent.setAgentVisibility'))
    .use(withManagedLocalAgentGuard(pickId))
    .input(z.object({ id: z.string(), visibility: z.enum(['private', 'public']) }))
    .mutation(async ({ input, ctx }) => {
      const meta = await ctx.agentModel.getAgentVisibilityMeta(input.id);
      if (!meta) throw new TRPCError({ code: 'NOT_FOUND', message: 'Agent not found' });

      if (meta.slug && Object.values(BUILTIN_AGENT_SLUGS).includes(meta.slug as any)) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Builtin agents cannot change visibility',
        });
      }

      if (meta.visibility === input.visibility) return { success: true };

      if (ctx.workspaceId && meta.userId !== ctx.userId) {
        const canOverride = await hasWorkspaceScopedPermission({
          action: 'AGENT_UPDATE',
          db: ctx.serverDB,
          scopes: ['ALL'],
          userId: ctx.userId,
          workspaceId: ctx.workspaceId,
        });
        if (!canOverride) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Only the agent creator or workspace owner can change visibility',
          });
        }
      }

      // Demoting an agent must not strand tasks that depend on it: public
      // tasks would violate the `assertAgentVisibilityCompat` invariant
      // (members keep seeing the task but can no longer see or run the
      // assignee), and other members' tasks — private ones included — would
      // fail future runs/updates because their creators can no longer
      // resolve the agent. Reject early — reassign or demote those tasks
      // first.
      if (input.visibility === 'private' && ctx.workspaceId) {
        const taskModel = new TaskModel(ctx.serverDB, ctx.userId, ctx.workspaceId);
        const blockingTasks = await taskModel.countTasksBlockingAgentDemotion(
          input.id,
          meta.userId,
        );
        if (blockingTasks > 0) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message:
              'Cannot make this agent private while workspace tasks still depend on it. Reassign those tasks or make them private first.',
          });
        }
      }

      const updated = await ctx.agentModel.setVisibility(input.id, input.visibility);
      if (!updated) throw new TRPCError({ code: 'NOT_FOUND', message: 'Agent not found' });

      return { success: true };
    }),

  createAgentFiles: agentProcedure
    .use(withScopedPermission('agent:update'))
    .use(withManagedResourceGuard('agent.createAgentFiles'))
    .use(withManagedLocalAgentGuard(pickAgentId))
    .input(
      z.object({
        agentId: z.string(),
        enabled: z.boolean().optional(),
        fileIds: z.array(z.string()),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      return ctx.agentModel.createAgentFiles(input.agentId, input.fileIds, input.enabled);
    }),

  createAgentKnowledgeBase: agentProcedure
    .use(withScopedPermission('agent:update'))
    .use(withManagedResourceGuard('agent.createAgentKnowledgeBase'))
    .use(withManagedLocalAgentGuard(pickAgentId))
    .input(
      z.object({
        agentId: z.string(),
        enabled: z.boolean().optional(),
        knowledgeBaseId: z.string(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      return ctx.agentModel.createAgentKnowledgeBase(
        input.agentId,
        input.knowledgeBaseId,
        input.enabled,
      );
    }),

  /**
   * Create an agent without session.
   * Used for Group Agent Builder to create agents for groups.
   * Returns only the agent ID.
   */
  createAgentOnly: agentProcedure
    .use(withScopedPermission('agent:create'))
    .use(withManagedResourceGuard('agent.createAgentOnly'))
    .input(
      z.object({
        config: z.object({}).passthrough().optional(),
        groupId: z.string(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // Create the agent entity only (no session)
      const agent = await ctx.agentModel.create(input.config ?? {});

      // Add the agent to the group
      await ctx.chatGroupModel.addAgentToGroup(input.groupId, agent.id);

      return { agentId: agent.id };
    }),

  deleteAgentFile: agentProcedure
    .use(withScopedPermission('agent:update'))
    .use(withManagedResourceGuard('agent.deleteAgentFile'))
    .use(withManagedLocalAgentGuard(pickAgentId))
    .input(
      z.object({
        agentId: z.string(),
        fileId: z.string(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      return ctx.agentModel.deleteAgentFile(input.agentId, input.fileId);
    }),

  deleteAgentKnowledgeBase: agentProcedure
    .use(withScopedPermission('agent:update'))
    .use(withManagedResourceGuard('agent.deleteAgentKnowledgeBase'))
    .use(withManagedLocalAgentGuard(pickAgentId))
    .input(
      z.object({
        agentId: z.string(),
        knowledgeBaseId: z.string(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      return ctx.agentModel.deleteAgentKnowledgeBase(input.agentId, input.knowledgeBaseId);
    }),

  /**
   * Duplicate an agent and its associated session.
   * Returns the new agent ID and session ID.
   */
  duplicateAgent: agentProcedure
    .use(withScopedPermission('agent:fork'))
    .use(withManagedResourceGuard('agent.duplicateAgent'))
    // A managed platform Agent must not be duplicated into an unmanaged local copy either.
    .use(withManagedLocalAgentGuard(pickAgentId))
    .input(
      z.object({
        agentId: z.string(),
        newTitle: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      return ctx.agentModel.duplicate(input.agentId, input.newTitle);
    }),

  /**
   * Get an agent by forkedFromIdentifier stored in params
   * @returns agent id if exists, null otherwise
   */
  getAgentByForkedFromIdentifier: agentProcedure
    .input(
      z.object({
        forkedFromIdentifier: z.string(),
      }),
    )
    .query(async ({ input, ctx }) => {
      return ctx.agentModel.getAgentByForkedFromIdentifier(input.forkedFromIdentifier);
    }),

  /**
   * Get an agent by marketIdentifier
   * @returns agent id if exists, null otherwise
   */
  getAgentByMarketIdentifier: agentProcedure
    .input(
      z.object({
        marketIdentifier: z.string(),
      }),
    )
    .query(async ({ input, ctx }) => {
      return ctx.agentModel.getAgentByMarketIdentifier(input.marketIdentifier);
    }),

  getAgentConfig: agentProcedure
    .input(
      z.object({
        sessionId: z.string(),
      }),
    )
    .query(async ({ input, ctx }) => {
      if (input.sessionId === INBOX_SESSION_ID) {
        const item = await ctx.sessionModel.findByIdOrSlug(INBOX_SESSION_ID);
        // if there is no session for user, create one
        if (!item) {
          // if there is no user, return default config
          const user = await UserModel.findById(ctx.serverDB, ctx.userId);
          if (!user) return DEFAULT_AGENT_CONFIG;

          const res = await ctx.agentService.createInbox();
          console.info('create inbox session', res);
        }
      }

      const session = await ctx.sessionModel.findByIdOrSlug(input.sessionId);

      if (!session) throw new Error(`Session [${input.sessionId}] not found`);
      const sessionId = session.id;

      const agent = await ctx.agentModel.findBySessionId(sessionId);
      if (agent?.id) {
        await assertLocalAgentReadableUnderTakeover({
          db: ctx.serverDB,
          identifier: agent.id,
          slug: agent.slug,
          userId: ctx.userId,
          workspaceId: ctx.workspaceId ?? undefined,
        });
      }
      return agent;
    }),

  getAgentConfigById: agentProcedure
    .input(
      z.object({
        agentId: z.string(),
      }),
    )
    .query(async ({ input, ctx }) => {
      // Same encoded-id seam execAgent uses (`decodePlatformAgentListId` + effective
      // catalog). `lh agent view <id-from-list>` under takeover otherwise looks up
      // `platform-agent:<uuid>` as a local row and returns not-found. Read path only
      // — does not materialize.
      const platformAgentId = decodePlatformAgentListId(input.agentId);
      if (platformAgentId) {
        const effective = await new PlatformAgentEffectiveResolver(ctx.serverDB).getEffectiveAgent(
          ctx.userId,
          platformAgentId,
        );
        if (!effective) return null;
        return {
          ...DEFAULT_AGENT_CONFIG,
          avatar: effective.config.avatar,
          backgroundColor: effective.config.backgroundColor ?? undefined,
          description: effective.config.description,
          id: input.agentId,
          openingMessage: effective.config.openingMessage ?? undefined,
          openingQuestions: effective.config.openingQuestions,
          platform: {
            distribution: effective.distribution,
            managed: true as const,
            source: 'platform' as const,
          },
          slug: null,
          systemRole: effective.config.systemRole,
          title: effective.config.displayName,
        };
      }

      const agent = await ctx.agentService.getAgentConfigById(input.agentId);
      if (agent) {
        await assertLocalAgentReadableUnderTakeover({
          db: ctx.serverDB,
          identifier: agent.id ?? input.agentId,
          userId: ctx.userId,
          workspaceId: ctx.workspaceId ?? undefined,
        });
      }
      return agent;
    }),

  /**
   * Get a builtin agent by slug, creating it if it doesn't exist.
   * This is a generic interface for all builtin agents (page-copilot, inbox, etc.)
   */
  getBuiltinAgent: agentProcedure
    .input(
      z.object({
        slug: z.string(),
      }),
    )
    .query(async ({ input, ctx }) => {
      return ctx.agentService.getBuiltinAgent(input.slug);
    }),

  getKnowledgeBasesAndFiles: agentProcedure
    .input(
      z.object({
        agentId: z.string(),
        visibility: z.enum(['private', 'public']).optional(),
      }),
    )
    .query(async ({ ctx, input }): Promise<KnowledgeItem[]> => {
      // Look up the target agent's visibility so we can (a) apply the
      // "public agent cannot reach caller's private rows" defensive filter
      // in the model layer, and (b) hard-force `visibility='public'` when
      // the agent is public — the client tab is a UX aid, not a gate.
      const agentVisibility = await ctx.agentModel.getAgentVisibility(input.agentId);
      const effectiveVisibility =
        agentVisibility === 'public' ? ('public' as const) : input.visibility;

      const knowledgeBases = await ctx.knowledgeBaseModel.query({
        callerAgentVisibility: agentVisibility,
        visibility: effectiveVisibility,
      });

      const files = await ctx.fileModel.query({
        callerAgentVisibility: agentVisibility,
        showFilesInKnowledgeBase: false,
        visibility: effectiveVisibility,
      });

      const knowledge = await ctx.agentModel.getAgentAssignedKnowledge(input.agentId);

      return [
        ...files
          // Filter out all images
          .filter((file) => !file.fileType.startsWith('image'))
          .map((file) => ({
            enabled: knowledge.files.some((item) => item.id === file.id),
            fileType: file.fileType,
            id: file.id,
            name: file.name,
            ownerUserId: file.userId,
            type: KnowledgeType.File,
            visibility: file.visibility as 'private' | 'public',
          })),
        ...knowledgeBases.map((knowledgeBase) => ({
          avatar: knowledgeBase.avatar,
          description: knowledgeBase.description,
          enabled: knowledge.knowledgeBases.some((item) => item.id === knowledgeBase.id),
          id: knowledgeBase.id,
          name: knowledgeBase.name,
          ownerUserId: knowledgeBase.userId,
          type: KnowledgeType.KnowledgeBase,
          visibility: knowledgeBase.visibility,
        })),
      ];
    }),

  /**
   * Query non-virtual agents with optional keyword filter.
   * Returns agents with minimal info (id, title, description, avatar, backgroundColor).
   * Used by AddGroupMemberModal and group-management tool to search/select agents.
   */
  queryAgents: agentProcedure
    // M10 PR-049 (REWORK-3): this endpoint gains a managed-Agent surface, so when the managed flag
    // is on it must reject banned/inactive/epoch-invalid principals before any platform catalog
    // access. Flag off → no-op, legacy local-only behavior preserved.
    .use(withActiveUserWhenManagedAgents())
    .input(
      z
        .object({
          keyword: z.string().optional(),
          limit: z.number().max(100).optional(),
          offset: z.number().optional(),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      // Unified list (M10 PR-049 · A): merge the user's own non-virtual agents with the effective
      // platform agents. Deterministic order/pagination; local rows already materialized from a
      // platform Agent are excluded (represented by their platform item). Flag off → the projection
      // short-circuits with zero catalog access and this returns the legacy local-only result.
      const limit = input?.limit ?? 9999;
      const offset = input?.offset ?? 0;
      return new PlatformAgentUserListService(
        ctx.serverDB,
        ctx.workspaceId ?? undefined,
      ).mergeAvailableAgents(
        ctx.userId,
        { keyword: input?.keyword, limit, offset },
        (localParams) => ctx.agentModel.queryAgents(localParams),
        // Disabled flag: invoke the exact pre-managed endpoint path, including an undefined input
        // and its original defaults/pagination semantics.
        () => ctx.agentModel.queryAgents(input),
      );
    }),

  rankAgents: agentProcedure.input(z.number().max(50).optional()).query(async ({ ctx, input }) => {
    const visible = await ctx.agentService.getTakeoverVisibleLocalAgentIds();
    return ctx.agentModel.rank(input, visible ? [...visible] : undefined);
  }),

  /**
   * Remove an agent and its associated session
   */
  removeAgent: agentProcedure
    .use(withScopedPermission('agent:delete'))
    .use(withManagedResourceGuard('agent.removeAgent'))
    // ROOT-02 / RR2-4: a platform-managed materialized Agent cannot be deleted through the ordinary
    // path (unified guard, runs before the handler → zero writes on reject).
    .use(withManagedLocalAgentGuard(pickAgentId))
    .input(z.object({ agentId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      // A synthetic platform list id (`platform-agent:<uuid>`) can never match a local agent row,
      // so `delete` would silently affect 0 rows and the client would show a false success. Reject
      // it explicitly so any managed-item delete surfaces as an error instead of a phantom success.
      if (decodePlatformAgentListId(input.agentId)) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Platform-managed agents cannot be deleted.',
        });
      }
      return ctx.agentModel.delete(input.agentId);
    }),

  toggleFile: agentProcedure
    .use(withScopedPermission('agent:update'))
    .use(withManagedResourceGuard('agent.toggleFile'))
    .use(withManagedLocalAgentGuard(pickAgentId))
    .input(
      z.object({
        agentId: z.string(),
        enabled: z.boolean().optional(),
        fileId: z.string(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      return ctx.agentModel.toggleFile(input.agentId, input.fileId, input.enabled);
    }),

  toggleKnowledgeBase: agentProcedure
    .use(withScopedPermission('agent:update'))
    .use(withManagedResourceGuard('agent.toggleKnowledgeBase'))
    .use(withManagedLocalAgentGuard(pickAgentId))
    .input(
      z.object({
        agentId: z.string(),
        enabled: z.boolean().optional(),
        knowledgeBaseId: z.string(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      return ctx.agentModel.toggleKnowledgeBase(
        input.agentId,
        input.knowledgeBaseId,
        input.enabled,
      );
    }),

  transferAgent: agentProcedure
    .use(withScopedPermission('agent:update'))
    .use(withManagedResourceGuard('agent.transferAgent'))
    .use(withManagedLocalAgentGuard(pickAgentId))
    .input(
      z.object({
        agentId: z.string(),
        targetVisibility: z.enum(['private', 'public']).optional(),
        targetWorkspaceId: z.string().nullable(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // 1. Fetch the agent to check ownership
      const agent = await ctx.agentModel.getAgentConfigById(input.agentId);
      if (!agent) {
        throw new TRPCError({
          cause: { data: { code: TransferErrorCode.ResourceNotFound } },
          code: 'NOT_FOUND',
          message: 'Agent not found',
        });
      }

      // 2. In workspace mode, members can only transfer agents they created;
      //    workspace owners can transfer any agent
      if (ctx.workspaceId && agent.userId !== ctx.userId) {
        const canOverride = await hasWorkspaceScopedPermission({
          action: 'AGENT_UPDATE',
          db: ctx.serverDB,
          scopes: ['ALL'],
          userId: ctx.userId,
          workspaceId: ctx.workspaceId,
        });

        if (!canOverride) {
          throw new TRPCError({
            cause: { data: { code: TransferErrorCode.OwnerOnly } },
            code: 'FORBIDDEN',
            message: 'Only workspace owners can transfer agents created by others',
          });
        }
      }

      // 3. Validate target workspace access (user must be member+)
      if (input.targetWorkspaceId) {
        const canWriteTarget = await hasWorkspaceScopedPermission({
          action: 'AGENT_CREATE',
          db: ctx.serverDB,
          userId: ctx.userId,
          workspaceId: input.targetWorkspaceId,
        });

        if (!canWriteTarget) {
          throw new TRPCError({
            cause: { data: { code: TransferErrorCode.TargetNoWriteAccess } },
            code: 'FORBIDDEN',
            message: 'No write access to target workspace',
          });
        }
      }

      // 4. Cannot transfer to the same workspace
      if (input.targetWorkspaceId === ctx.workspaceId) {
        throw new TRPCError({
          cause: { data: { code: TransferErrorCode.SameWorkspace } },
          code: 'BAD_REQUEST',
          message: 'Cannot transfer agent to the same workspace',
        });
      }

      return ctx.agentModel.transferAgent(
        input.agentId,
        input.targetWorkspaceId,
        ctx.userId,
        input.targetVisibility,
      );
    }),

  updateAgentConfig: agentProcedure
    .use(withScopedPermission('agent:update'))
    .use(withManagedResourceGuard('agent.updateAgentConfig'))
    // ROOT-02 / RR2-4: managed fields on a platform-materialized Agent are not user-editable.
    .use(withManagedLocalAgentGuard(pickAgentId))
    .input(
      z.object({
        agentId: z.string(),
        value: z.object({}).passthrough().partial(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // Collaborative edit lock: reject writes to a workspace agent another
      // member is actively editing. Inert until a client acquires the lock.
      if (ctx.workspaceId) {
        const blockedBy = await ctx.editLockService.getBlockingHolder('agent', input.agentId);
        if (blockedBy) {
          throw new TRPCError({
            cause: { data: { code: 'DocumentLocked' } },
            code: 'CONFLICT',
            message: 'Agent is being edited by another user',
          });
        }
      }

      // Use AgentService to update and return the updated agent data
      return ctx.agentService.updateAgentConfig(input.agentId, input.value);
    }),

  /**
   * Pin or unpin an agent
   */
  updateAgentPinned: agentProcedure
    .use(withScopedPermission('agent:update'))
    .use(withManagedResourceGuard('agent.updateAgentPinned'))
    // ROOT-02 / RR2-4: a platform-managed materialized Agent is not user-manageable via this path.
    .use(withManagedLocalAgentGuard(pickId))
    .input(
      z.object({
        id: z.string(),
        pinned: z.boolean(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      return ctx.agentModel.update(input.id, { pinned: input.pinned });
    }),

  acquireAgentLock: agentProcedure
    .use(withScopedPermission('agent:update'))
    .use(withManagedResourceGuard('agent.acquireAgentLock'))
    .use(withManagedLocalAgentGuard(pickAgentId))
    .input(z.object({ agentId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.workspaceId) return { expiresAt: null, holderId: null, lockedByOther: false };
      const prev = await ctx.editLockService.getActiveHolder('agent', input.agentId);
      const result = await ctx.editLockService.acquire('agent', input.agentId);
      if ((result.holderId ?? null) !== (prev ?? null)) {
        void publishResourceEvent(
          { id: input.agentId, type: 'agent' },
          { actorId: ctx.userId, data: { holderId: result.holderId }, type: 'lock.changed' },
        );
      }
      return result;
    }),

  getAgentLock: agentProcedure
    .use(withScopedPermission('agent:update'))
    .input(z.object({ agentId: z.string() }))
    .query(async ({ ctx, input }) => {
      if (!ctx.workspaceId) return { expiresAt: null, holderId: null, lockedByOther: false };
      const holder = await ctx.editLockService.getActiveHolder('agent', input.agentId);
      return {
        expiresAt: null,
        holderId: holder ?? null,
        lockedByOther: Boolean(holder) && holder !== ctx.userId,
      };
    }),

  releaseAgentLock: agentProcedure
    .use(withScopedPermission('agent:update'))
    .use(withManagedResourceGuard('agent.releaseAgentLock'))
    .use(withManagedLocalAgentGuard(pickAgentId))
    .input(z.object({ agentId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.workspaceId) return;
      // Only broadcast "unlocked" when we actually released our own lock — if the
      // lease expired and another member took over, the lock is still held.
      const released = await ctx.editLockService.release('agent', input.agentId);
      if (!released) return;
      void publishResourceEvent(
        { id: input.agentId, type: 'agent' },
        { actorId: ctx.userId, data: { holderId: null }, type: 'lock.changed' },
      );
    }),
});
