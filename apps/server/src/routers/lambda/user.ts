import {
  EMPTY_DOCUMENT_MESSAGES,
  formatWebOnboardingStateMessage,
} from '@lobechat/builtin-tool-web-onboarding/utils';
import { isDesktop } from '@lobechat/const';
import { applyMarkdownPatch, formatMarkdownPatchError } from '@lobechat/markdown-patch';
import {
  type UserInitializationState,
  type UserPreference,
  type UserSettings,
} from '@lobechat/types';
import {
  Plans,
  SaveUserQuestionInputSchema,
  UserAgentOnboardingSchema,
  UserGuideSchema,
  UserOnboardingSchema,
  UserPreferenceSchema,
  UserSettingsSchema,
} from '@lobechat/types';
import { TRPCError } from '@trpc/server';
import { after } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';

import {
  getReferralStatus,
  getSubscriptionPlan,
  onUserActivityForBusiness,
} from '@/business/server/user';
import { MessageModel } from '@/database/models/message';
import { SessionModel } from '@/database/models/session';
import { UserModel } from '@/database/models/user';
import { UserPersonaModel } from '@/database/models/userMemory/persona';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';
import {
  userSettingsGetEffectiveOutputSchema,
  userSettingsPatchOverrideInputSchema,
  userSettingsPatchOverrideOutputSchema,
  userSettingsResetOverrideInputSchema,
  userSettingsResetOverrideOutputSchema,
} from '@/server/enterprise/contracts/userSettings';
import { throwEnterpriseError } from '@/server/enterprise/guards/enterpriseErrors';
import { assertDefaultInboxNotPlatformManaged } from '@/server/enterprise/guards/managedPlatformAgent';
import { userConnectorsRouter } from '@/server/enterprise/routers/user/connectors';
import {
  EffectiveSettingsService,
  SettingsPathError,
} from '@/server/enterprise/services/settings/effectiveSettingsService';
import { settingsRegistry } from '@/server/enterprise/services/settings/registry';
import { loadEffectiveUserSettings } from '@/server/enterprise/services/settings/runtimeSettingsAdapter';
import { assertWorkspaceSettingsWritePermission } from '@/server/enterprise/services/settings/workspaceSettingsPermission';
import { KeyVaultsGateKeeper } from '@/server/modules/KeyVaultsEncrypt';
import { FileS3 } from '@/server/modules/S3';
import { AgentDocumentsService } from '@/server/services/agentDocuments';
import { FileService } from '@/server/services/file';
import { OnboardingService } from '@/server/services/onboarding';

const usernameSchema = z
  .string()
  .trim()
  .min(1, { message: 'USERNAME_REQUIRED' })
  .max(64, { message: 'USERNAME_TOO_LONG' })
  .regex(/^\w+$/, { message: 'USERNAME_INVALID' });

const AVATAR_WEBAPI_PREFIX = '/webapi/';

// Accept only: base64 data URL, absolute http(s) URL, empty string,
// or an internal /webapi/user/avatar/<userId>/... path scoped to the caller.
// Any other value (relative path, file://, s3://, path-traversal, or another
// user's prefix) is rejected so a later upload can't be tricked into deleting
// an arbitrary S3 key via the "delete old avatar" step.
const assertSafeAvatarInput = (input: string, userId: string) => {
  if (input.length === 0) return;
  if (input.startsWith('data:image')) return;

  const ownPrefix = `${AVATAR_WEBAPI_PREFIX}user/avatar/${userId}/`;
  if (input.startsWith(ownPrefix) && !input.includes('..')) return;

  try {
    const { protocol } = new URL(input);
    if (protocol === 'http:' || protocol === 'https:') return;
  } catch {
    /* not a parseable absolute URL — fall through to reject */
  }

  throw new TRPCError({ code: 'BAD_REQUEST', message: 'INVALID_AVATAR_URL' });
};

const userProcedure = authedProcedure.use(serverDatabase).use(async ({ ctx, next }) => {
  return next({
    ctx: {
      fileService: new FileService(ctx.serverDB, ctx.userId),
      // workspace-audit: intentionally personal-scoped (no workspaceId). These models
      // only feed `getUserState`'s user-lifetime onboarding gates (hasConversation /
      // canEnablePWAGuide / canEnableTrace), which are per-user, not per-workspace.
      messageModel: new MessageModel(ctx.serverDB, ctx.userId),
      sessionModel: new SessionModel(ctx.serverDB, ctx.userId),
      userModel: new UserModel(ctx.serverDB, ctx.userId),
    },
  });
});

export const userRouter = router({
  connectors: userConnectorsRouter,

  getUserActivitySummary: userProcedure.query(async ({ ctx }) => {
    return ctx.userModel.getUserActivitySummary();
  }),

  getUserRegistrationDuration: userProcedure.query(async ({ ctx }) => {
    return ctx.userModel.getUserRegistrationDuration();
  }),

  getUserSSOProviders: userProcedure.query(async ({ ctx }) => {
    return ctx.userModel.getUserSSOProviders();
  }),

  getUserState: userProcedure.query(async ({ ctx }): Promise<UserInitializationState> => {
    try {
      after(async () => {
        try {
          const currentTime = new Date();
          const transition = await ctx.userModel.advanceLastActiveAt(currentTime);

          if (transition) {
            try {
              await onUserActivityForBusiness({
                currentTime,
                previousLastActiveAt: transition.previousLastActiveAt,
                userCreatedAt: transition.userCreatedAt,
                userId: ctx.userId,
              });
            } catch (err) {
              console.error('user activity hook failed, error:', err);
            }
          }
        } catch (err) {
          console.error('update lastActiveAt failed, error:', err);
        }
      });
    } catch {
      // `after` may fail outside request scope (e.g., in tests), ignore silently
    }

    // For desktop mode, ensure user exists before getting state
    if (isDesktop) {
      await UserModel.makeSureUserExist(ctx.serverDB, ctx.userId);
    }

    // Run user state fetch and count queries in parallel
    const [state, messageCount, hasExtraSession, referralStatus, subscriptionPlan] =
      await Promise.all([
        ctx.userModel.getUserState(KeyVaultsGateKeeper.getUserKeyVaults),
        ctx.messageModel.countUpTo(5),
        ctx.sessionModel.hasMoreThanN(1),
        getReferralStatus(ctx.userId),
        getSubscriptionPlan(ctx.userId),
      ]);

    const hasMoreThan4Messages = messageCount > 4;
    const hasAnyMessages = messageCount > 0;

    // M05: Flag ON → server-resolved effective settings; Flag OFF → exact parent sparse settings
    const { settings: resolvedSettings } = await loadEffectiveUserSettings({
      db: ctx.serverDB,
      legacySettings: state.settings as Record<string, unknown>,
      userId: ctx.userId,
    });

    return {
      avatar: state.avatar,
      canEnablePWAGuide: hasMoreThan4Messages,
      canEnableTrace: hasMoreThan4Messages,
      email: state.email,
      firstName: state.firstName,
      fullName: state.fullName,

      // Has conversation if there are messages or has created any assistant
      hasConversation: hasAnyMessages || hasExtraSession,

      agentOnboarding: state.agentOnboarding,
      interests: state.interests,

      // always return true for community version
      isOnboard: state.isOnboarded ?? true,
      lastName: state.lastName,
      onboarding: state.onboarding,
      preference: state.preference as UserPreference,
      settings: resolvedSettings as UserInitializationState['settings'],
      userId: ctx.userId,
      username: state.username,

      // business features
      referralStatus,
      subscriptionPlan,
      isFreePlan: !subscriptionPlan || subscriptionPlan === Plans.Free,
    } satisfies UserInitializationState;
  }),

  makeUserOnboarded: userProcedure.mutation(async ({ ctx }) => {
    return ctx.userModel.updateUser({ isOnboarded: true });
  }),

  resetSettings: userProcedure.mutation(async ({ ctx }) => {
    // Full reset: Flag OFF → delete user_settings only (parent).
    // Flag ON → atomically delete all overrides + revision bump + legacy row (incl. keyVaults).
    const service = new EffectiveSettingsService(ctx.serverDB);
    if (service.isPolicyEnabled()) {
      const perm = await assertWorkspaceSettingsWritePermission({
        db: ctx.serverDB,
        paths: [...settingsRegistry.paths()],
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
      });
      if (!perm.ok) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You do not have permission to perform this action.',
        });
      }
    }
    return service.fullResetSettings({ userId: ctx.userId });
  }),

  /**
   * M05: server-resolved effective settings + per-path source/locked/hidden metadata.
   * When ENABLE_PLATFORM_SETTINGS_POLICY is off, returns built-in + legacy merge only.
   */
  getEffectiveSettings: userProcedure
    .output(userSettingsGetEffectiveOutputSchema)
    .query(async ({ ctx }) => {
      const service = new EffectiveSettingsService(ctx.serverDB);
      const state = await ctx.userModel.getUserState(KeyVaultsGateKeeper.getUserKeyVaults);
      // Strip keyVaults from legacy blob fed into resolver pathMeta
      const { keyVaults: _kv, ...legacy } = (state.settings ?? {}) as Record<string, unknown> & {
        keyVaults?: unknown;
      };
      return service.getEffectiveSettings({
        legacyUserSettings: legacy,
        userId: ctx.userId,
      });
    }),

  patchSettingOverride: userProcedure
    .input(userSettingsPatchOverrideInputSchema)
    .output(userSettingsPatchOverrideOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const perm = await assertWorkspaceSettingsWritePermission({
        db: ctx.serverDB,
        paths: [input.path],
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
      });
      if (!perm.ok) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You do not have permission to perform this action.',
        });
      }

      const service = new EffectiveSettingsService(ctx.serverDB);
      try {
        return await service.patchSettingOverride({
          // User lambda is interactive client; desktop/mobile share web eligibility set
          client: 'web',
          path: input.path,
          userId: ctx.userId,
          value: input.value,
        });
      } catch (error) {
        if (error instanceof SettingsPathError) {
          throwEnterpriseError({
            code: error.code as never,
            httpCode:
              error.code === 'MANAGED_SETTING_BY_ADMIN'
                ? 'FORBIDDEN'
                : error.code === 'PLATFORM_FEATURE_DISABLED'
                  ? 'FORBIDDEN'
                  : 'BAD_REQUEST',
            message: error.message,
          });
        }
        throw error;
      }
    }),

  resetSettingOverride: userProcedure
    .input(userSettingsResetOverrideInputSchema)
    .output(userSettingsResetOverrideOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const perm = await assertWorkspaceSettingsWritePermission({
        db: ctx.serverDB,
        paths: [input.path],
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
      });
      if (!perm.ok) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You do not have permission to perform this action.',
        });
      }

      const service = new EffectiveSettingsService(ctx.serverDB);
      try {
        return await service.resetSettingOverride({
          client: 'web',
          path: input.path,
          userId: ctx.userId,
        });
      } catch (error) {
        if (error instanceof SettingsPathError) {
          throwEnterpriseError({
            code: error.code as never,
            httpCode:
              error.code === 'MANAGED_SETTING_BY_ADMIN'
                ? 'FORBIDDEN'
                : error.code === 'PLATFORM_FEATURE_DISABLED'
                  ? 'FORBIDDEN'
                  : 'BAD_REQUEST',
            message: error.message,
          });
        }
        throw error;
      }
    }),

  updateAvatar: userProcedure.input(z.string()).mutation(async ({ ctx, input }) => {
    assertSafeAvatarInput(input, ctx.userId);

    // If it's Base64 data, need to upload to S3
    if (input.startsWith('data:image')) {
      try {
        // Extract mimeType, e.g., "image/png"
        const prefix = 'data:';
        const semicolonIndex = input.indexOf(';');
        const mimeType =
          semicolonIndex !== -1 ? input.slice(prefix.length, semicolonIndex) : 'image/png';
        const fileType = mimeType.split('/')[1];

        // Split string to get the Base64 part
        const commaIndex = input.indexOf(',');
        if (commaIndex === -1) {
          throw new Error('Invalid Base64 data');
        }
        const base64Data = input.slice(commaIndex + 1);

        // Create S3 client
        const s3 = new FileS3();

        // Use UUID to generate unique filename to prevent caching issues
        // Get old avatar URL for later deletion
        const userState = await ctx.userModel.getUserState(KeyVaultsGateKeeper.getUserKeyVaults);
        const oldAvatarUrl = userState.avatar;

        const fileName = `${uuidv4()}.${fileType}`;
        const filePath = `user/avatar/${ctx.userId}/${fileName}`;

        // Convert Base64 data to Buffer and upload to S3
        const buffer = Buffer.from(base64Data, 'base64');

        await s3.uploadBuffer(filePath, buffer, mimeType);

        // Delete old avatar — defense in depth: only touch keys inside the
        // caller's own avatar prefix, never external URLs or traversal paths.
        const ownAvatarWebapiPrefix = `${AVATAR_WEBAPI_PREFIX}user/avatar/${ctx.userId}/`;
        if (
          oldAvatarUrl &&
          oldAvatarUrl.startsWith(ownAvatarWebapiPrefix) &&
          !oldAvatarUrl.includes('..')
        ) {
          const oldFilePath = oldAvatarUrl.slice(AVATAR_WEBAPI_PREFIX.length);
          await s3.deleteFile(oldFilePath);
        }

        const avatarUrl = '/webapi/' + filePath;

        return ctx.userModel.updateUser({ avatar: avatarUrl });
      } catch (error) {
        throw new Error(
          'Error uploading avatar: ' + (error instanceof Error ? error.message : String(error)),
          { cause: error },
        );
      }
    }

    // If it's not Base64 data, directly use URL to update user avatar
    return ctx.userModel.updateUser({ avatar: input });
  }),

  updateFullName: userProcedure
    .input(z.string().trim().max(64, { message: 'FULLNAME_TOO_LONG' }))
    .mutation(async ({ ctx, input }) => {
      return ctx.userModel.updateUser({ fullName: input });
    }),

  updateGuide: userProcedure.input(UserGuideSchema).mutation(async ({ ctx, input }) => {
    return ctx.userModel.updateGuide(input);
  }),

  updateInterests: userProcedure.input(z.array(z.string())).mutation(async ({ ctx, input }) => {
    return ctx.userModel.updateUser({ interests: input });
  }),

  getOrCreateOnboardingState: userProcedure.query(async ({ ctx }) => {
    const onboardingService = new OnboardingService(ctx.serverDB, ctx.userId);

    return onboardingService.getOrCreateState();
  }),

  getOnboardingBootstrapState: userProcedure.query(async ({ ctx }) => {
    const onboardingService = new OnboardingService(ctx.serverDB, ctx.userId);

    return onboardingService.getBootstrapState();
  }),

  sendOnboardingFirstMessage: userProcedure
    .input(z.object({ agentId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const onboardingService = new OnboardingService(ctx.serverDB, ctx.userId);

      return onboardingService.sendOnboardingFirstMessage(input);
    }),

  getOnboardingAgentContext: userProcedure.query(async ({ ctx }) => {
    const onboardingService = new OnboardingService(ctx.serverDB, ctx.userId);
    const docService = new AgentDocumentsService(
      ctx.serverDB,
      ctx.userId,
      ctx.workspaceId ?? undefined,
    );
    const personaModel = new UserPersonaModel(ctx.serverDB, ctx.userId);

    const [state, soulDoc, persona, userInfo] = await Promise.all([
      onboardingService.getState(),
      onboardingService
        .getInboxAgentId()
        .then((inboxAgentId) => docService.getDocumentByFilename(inboxAgentId, 'SOUL.md'))
        .catch(() => null),
      personaModel.getLatestPersonaDocument().catch(() => null),
      onboardingService.getInitialUserInfo().catch(() => undefined),
    ]);

    return {
      discoveryUserMessageCount: state.discoveryUserMessageCount,
      personaContent: persona?.persona || null,
      phaseGuidance: formatWebOnboardingStateMessage(state),
      remainingDiscoveryExchanges: state.remainingDiscoveryExchanges,
      soulContent: soulDoc?.content || null,
      userInfo,
    };
  }),

  saveUserQuestion: userProcedure
    .input(SaveUserQuestionInputSchema)
    .mutation(async ({ ctx, input }) => {
      const onboardingService = new OnboardingService(ctx.serverDB, ctx.userId);

      return onboardingService.saveUserQuestion(input);
    }),

  finishOnboarding: userProcedure.input(z.object({})).mutation(async ({ ctx, input }) => {
    const onboardingService = new OnboardingService(ctx.serverDB, ctx.userId);
    void input;

    return onboardingService.finishOnboarding();
  }),

  readOnboardingDocument: userProcedure
    .input(z.object({ type: z.enum(['soul', 'persona']) }))
    .query(async ({ ctx, input }) => {
      if (input.type === 'soul') {
        const onboardingService = new OnboardingService(ctx.serverDB, ctx.userId);
        const docService = new AgentDocumentsService(
          ctx.serverDB,
          ctx.userId,
          ctx.workspaceId ?? undefined,
        );
        const inboxAgentId = await onboardingService.getInboxAgentId();
        const doc = await docService.getDocumentByFilename(inboxAgentId, 'SOUL.md');

        return {
          content: doc?.content || EMPTY_DOCUMENT_MESSAGES.soul,
          id: doc?.id ?? null,
          type: 'soul' as const,
        };
      }

      const personaModel = new UserPersonaModel(ctx.serverDB, ctx.userId);
      const persona = await personaModel.getLatestPersonaDocument();

      return {
        content: persona?.persona || EMPTY_DOCUMENT_MESSAGES.persona,
        id: persona?.id ?? null,
        type: 'persona' as const,
      };
    }),

  updateOnboardingDocument: userProcedure
    .input(z.object({ content: z.string(), type: z.enum(['soul', 'persona']) }))
    .mutation(async ({ ctx, input }) => {
      if (input.type === 'soul') {
        await assertDefaultInboxNotPlatformManaged({ db: ctx.serverDB, userId: ctx.userId });
        const onboardingService = new OnboardingService(ctx.serverDB, ctx.userId);
        const docService = new AgentDocumentsService(
          ctx.serverDB,
          ctx.userId,
          ctx.workspaceId ?? undefined,
        );
        const inboxAgentId = await onboardingService.getInboxAgentId();
        const doc = await docService.upsertDocumentByFilename({
          agentId: inboxAgentId,
          content: input.content,
          filename: 'SOUL.md',
        });

        return { id: doc?.id, type: 'soul' as const };
      }

      const personaModel = new UserPersonaModel(ctx.serverDB, ctx.userId);
      const result = await personaModel.upsertPersona({
        editedBy: 'agent_tool',
        persona: input.content,
        profile: 'default',
      });

      return { id: result.document.id, type: 'persona' as const };
    }),

  patchOnboardingDocument: userProcedure
    .input(
      z.object({
        hunks: z
          .array(
            z.union([
              z.object({
                mode: z.literal('replace').optional(),
                replace: z.string(),
                replaceAll: z.boolean().optional(),
                search: z.string(),
              }),
              z.object({
                mode: z.literal('delete'),
                replaceAll: z.boolean().optional(),
                search: z.string(),
              }),
              z.object({
                endLine: z.number().int(),
                mode: z.literal('deleteLines'),
                startLine: z.number().int(),
              }),
              z.object({
                content: z.string(),
                line: z.number().int(),
                mode: z.literal('insertAt'),
              }),
              z.object({
                content: z.string(),
                endLine: z.number().int(),
                mode: z.literal('replaceLines'),
                startLine: z.number().int(),
              }),
            ]),
          )
          .min(1),
        type: z.enum(['soul', 'persona']),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.type === 'soul') {
        await assertDefaultInboxNotPlatformManaged({ db: ctx.serverDB, userId: ctx.userId });
      }

      const readCurrent = async (): Promise<string> => {
        if (input.type === 'soul') {
          const onboardingService = new OnboardingService(ctx.serverDB, ctx.userId);
          const docService = new AgentDocumentsService(
            ctx.serverDB,
            ctx.userId,
            ctx.workspaceId ?? undefined,
          );
          const inboxAgentId = await onboardingService.getInboxAgentId();
          const doc = await docService.getDocumentByFilename(inboxAgentId, 'SOUL.md');
          return doc?.content ?? '';
        }

        const personaModel = new UserPersonaModel(ctx.serverDB, ctx.userId);
        const persona = await personaModel.getLatestPersonaDocument();
        return persona?.persona ?? '';
      };

      const current = await readCurrent();
      const patched = applyMarkdownPatch(current, input.hunks);
      if (!patched.ok) {
        throw new TRPCError({
          cause: patched.error,
          code: 'BAD_REQUEST',
          message: formatMarkdownPatchError(patched.error),
        });
      }

      if (input.type === 'soul') {
        const onboardingService = new OnboardingService(ctx.serverDB, ctx.userId);
        const docService = new AgentDocumentsService(
          ctx.serverDB,
          ctx.userId,
          ctx.workspaceId ?? undefined,
        );
        const inboxAgentId = await onboardingService.getInboxAgentId();
        const doc = await docService.upsertDocumentByFilename({
          agentId: inboxAgentId,
          content: patched.content,
          filename: 'SOUL.md',
        });

        return { applied: patched.applied, id: doc?.id, type: 'soul' as const };
      }

      const personaModel = new UserPersonaModel(ctx.serverDB, ctx.userId);
      const result = await personaModel.upsertPersona({
        editedBy: 'agent_tool',
        persona: patched.content,
        profile: 'default',
      });

      return { applied: patched.applied, id: result.document.id, type: 'persona' as const };
    }),

  resetAgentOnboarding: userProcedure.mutation(async ({ ctx }) => {
    const onboardingService = new OnboardingService(ctx.serverDB, ctx.userId);

    return onboardingService.reset();
  }),

  updateAgentOnboarding: userProcedure
    .input(UserAgentOnboardingSchema)
    .mutation(async ({ ctx, input }) => {
      return ctx.userModel.updateUser({ agentOnboarding: input });
    }),

  updateOnboarding: userProcedure.input(UserOnboardingSchema).mutation(async ({ ctx, input }) => {
    return ctx.userModel.updateUser({ onboarding: input });
  }),

  updatePreference: userProcedure.input(UserPreferenceSchema).mutation(async ({ ctx, input }) => {
    return ctx.userModel.updatePreference(input);
  }),

  updateSettings: userProcedure.input(UserSettingsSchema).mutation(async ({ ctx, input }) => {
    const { keyVaults, ...res } = input as Partial<UserSettings>;

    // The legacy settings blob used to be able to rewrite inbox model/provider/prompt/plugins.
    // Reject that narrow path before permissions, encryption, or writes when default-inbox is
    // managed. Resolver/DB failure propagates, so an error cannot be treated as legacy absence.
    if ('defaultAgent' in res) {
      await assertDefaultInboxNotPlatformManaged({ db: ctx.serverDB, userId: ctx.userId });
    }

    // Shared workspace permission (same rules for legacy + path patch/reset)
    const topKeys = Object.keys(res);
    const perm = await assertWorkspaceSettingsWritePermission({
      db: ctx.serverDB,
      paths: topKeys,
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    if (!perm.ok) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'You do not have permission to perform this action.',
      });
    }

    // Encrypt keyVaults before any txn — always outside platform policy semantics
    let encryptedKeyVaults: string | null | undefined = undefined;

    if (keyVaults) {
      const data = JSON.stringify(keyVaults);
      const gateKeeper = await KeyVaultsGateKeeper.initWithEnvKey();
      encryptedKeyVaults = await gateKeeper.encrypt(data);
    }

    const settingsService = new EffectiveSettingsService(ctx.serverDB);

    // Flag ON: strict catalog + atomic overrides + legacy remainder in one transaction
    if (settingsService.isPolicyEnabled()) {
      try {
        return await settingsService.applyLegacyUpdateSettings({
          encryptedKeyVaults,
          input: { ...res, ...(keyVaults ? { keyVaults } : {}) } as Record<string, unknown>,
          userId: ctx.userId,
        });
      } catch (error) {
        if (error instanceof SettingsPathError) {
          throwEnterpriseError({
            code: error.code as never,
            httpCode: error.code === 'MANAGED_SETTING_BY_ADMIN' ? 'FORBIDDEN' : 'BAD_REQUEST',
            message: error.message,
          });
        }
        throw error;
      }
    }

    // Flag OFF: unchanged upstream behavior
    const nextValue = {
      ...res,
      ...(encryptedKeyVaults !== undefined ? { keyVaults: encryptedKeyVaults } : {}),
    };

    return ctx.userModel.updateSetting(nextValue);
  }),

  updateUsername: userProcedure.input(usernameSchema).mutation(async ({ ctx, input }) => {
    const existedUser = await UserModel.findByUsername(ctx.serverDB, input);
    if (existedUser && existedUser.id !== ctx.userId) {
      throw new TRPCError({ code: 'CONFLICT', message: 'USERNAME_TAKEN' });
    }

    return ctx.userModel.updateUser({ username: input });
  }),
});

export type UserRouter = typeof userRouter;
