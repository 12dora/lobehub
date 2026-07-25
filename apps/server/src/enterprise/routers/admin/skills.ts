import { z } from 'zod';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import {
  adminSkillApplyImmediateInputSchema,
  adminSkillApplyImmediateOutputSchema,
  adminSkillArchiveInputSchema,
  adminSkillCreateInputSchema,
  adminSkillCreateVersionInputSchema,
  adminSkillCreateVersionOutputSchema,
  adminSkillGetDependentsInputSchema,
  adminSkillGetDependentsOutputSchema,
  adminSkillGetInputSchema,
  adminSkillGetOutputSchema,
  adminSkillGetVersionInputSchema,
  adminSkillGetVersionOutputSchema,
  adminSkillListInputSchema,
  adminSkillListOutputSchema,
  adminSkillListVersionsInputSchema,
  adminSkillListVersionsOutputSchema,
  adminSkillMutationOutputSchema,
  adminSkillParseImportSourceInputSchema,
  adminSkillParseImportSourceOutputSchema,
  adminSkillPublicationOutputSchema,
  adminSkillPublishInputSchema,
  adminSkillPublishNowInputSchema,
  adminSkillRollbackInputSchema,
  adminSkillUpdateDraftInputSchema,
  adminSkillValidateInputSchema,
  adminSkillValidateOutputSchema,
} from '../../contracts/skillCatalog';
import { withActiveUser } from '../../guards/activeUser';
import { withAdminMutationRateLimit } from '../../guards/adminMutationRateLimit';
import {
  withCompoundPlatformPermission,
  withPlatformPermission,
} from '../../guards/platformPermission';
import { parseSkillImportSource } from './skillsImportParse';
import {
  assertSkillDangerousReauth,
  assertSkillFeatureEnabled,
  createSkillService,
  mapSkillServiceError,
} from './skillsSupport';

/**
 * Archive of never-published shells keeps revision 0 (authority-safe). Publish/rollback
 * still require a positive revision via the shared publication schema.
 */
const adminSkillArchiveOutputSchema = adminSkillPublicationOutputSchema.extend({
  revision: z.number().int().nonnegative(),
});

const adminBase = authedProcedure
  .use(serverDatabase)
  .use(withActiveUser())
  .use(withAdminMutationRateLimit());

export const adminSkillsRouter = router({
  /**
   * Create/update/createVersion then publish in one procedure (admin settings UI parity).
   * Requires UPDATE+PUBLISH (or CREATE+PUBLISH / UPDATE+PUBLISH for createVersion). Rate-limit: 1 unit.
   */
  applyImmediate: adminBase
    .use(
      withCompoundPlatformPermission({
        fixed: [PLATFORM_PERMISSIONS.SKILL_PUBLISH],
        select: (raw) => {
          const mode = (raw as { mode?: string } | null)?.mode;
          return mode === 'create'
            ? PLATFORM_PERMISSIONS.SKILL_CREATE
            : PLATFORM_PERMISSIONS.SKILL_UPDATE;
        },
        selectable: [PLATFORM_PERMISSIONS.SKILL_CREATE, PLATFORM_PERMISSIONS.SKILL_UPDATE],
      }),
    )
    .input(adminSkillApplyImmediateInputSchema)
    .output(adminSkillApplyImmediateOutputSchema)
    .mutation(async ({ ctx, input }) => {
      assertSkillFeatureEnabled();
      await assertSkillDangerousReauth({
        action: 'admin.skills.applyImmediate',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        serverDB: ctx.serverDB,
        targetId:
          input.mode === 'create'
            ? input.skillKey
            : input.mode === 'createVersion'
              ? input.skillId
              : input.id,
      });
      try {
        return await createSkillService(ctx.serverDB).applyImmediate(ctx.userId!, input);
      } catch (error) {
        return mapSkillServiceError(error);
      }
    }),

  /**
   * Banner "retry publish": re-publish latest/specified version.
   * Same guard combo as applyImmediate (PUBLISH + reauth + rate-limit).
   */
  publishNow: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SKILL_PUBLISH))
    .input(adminSkillPublishNowInputSchema)
    .output(adminSkillApplyImmediateOutputSchema)
    .mutation(async ({ ctx, input }) => {
      assertSkillFeatureEnabled();
      await assertSkillDangerousReauth({
        action: 'admin.skills.publishNow',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        serverDB: ctx.serverDB,
        targetId: input.id,
      });
      try {
        return await createSkillService(ctx.serverDB).publishNow(ctx.userId!, input);
      } catch (error) {
        return mapSkillServiceError(error);
      }
    }),

  archive: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SKILL_DELETE))
    .input(adminSkillArchiveInputSchema)
    .output(adminSkillArchiveOutputSchema)
    .mutation(async ({ ctx, input }) => {
      assertSkillFeatureEnabled();
      await assertSkillDangerousReauth({
        action: 'admin.skills.archive',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        serverDB: ctx.serverDB,
        targetId: input.id,
      });
      try {
        return await createSkillService(ctx.serverDB).archive(ctx.userId!, input);
      } catch (error) {
        return mapSkillServiceError(error);
      }
    }),

  create: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SKILL_CREATE))
    .input(adminSkillCreateInputSchema)
    .output(adminSkillMutationOutputSchema)
    .mutation(async ({ ctx, input }) => {
      if (input.allowBuiltinOverride) {
        assertSkillFeatureEnabled();
        await assertSkillDangerousReauth({
          action: 'admin.skills.createBuiltinOverride',
          actorUserId: ctx.userId!,
          authenticatedAt: ctx.authenticatedAt,
          authMethod: ctx.authMethod,
          reason: input.reason,
          serverDB: ctx.serverDB,
          targetId: input.skillKey,
        });
      }
      try {
        return await createSkillService(ctx.serverDB).create(ctx.userId!, input);
      } catch (error) {
        return mapSkillServiceError(error);
      }
    }),

  createVersion: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SKILL_UPDATE))
    .input(adminSkillCreateVersionInputSchema)
    .output(adminSkillCreateVersionOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await createSkillService(ctx.serverDB).createVersion(ctx.userId!, input);
      } catch (error) {
        return mapSkillServiceError(error);
      }
    }),

  get: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SKILL_READ))
    .input(adminSkillGetInputSchema)
    .output(adminSkillGetOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await createSkillService(ctx.serverDB).getDetail(input.id);
      } catch (error) {
        return mapSkillServiceError(error);
      }
    }),

  getDependents: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SKILL_READ))
    .input(adminSkillGetDependentsInputSchema)
    .output(adminSkillGetDependentsOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await createSkillService(ctx.serverDB).getDependents(input);
      } catch (error) {
        return mapSkillServiceError(error);
      }
    }),

  getVersion: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SKILL_READ))
    .input(adminSkillGetVersionInputSchema)
    .output(adminSkillGetVersionOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await createSkillService(ctx.serverDB).getVersion(input.skillId, input.versionId);
      } catch (error) {
        return mapSkillServiceError(error);
      }
    }),

  list: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SKILL_READ))
    .input(adminSkillListInputSchema)
    .output(adminSkillListOutputSchema)
    .query(async ({ ctx, input }) => createSkillService(ctx.serverDB).list(input)),

  listVersions: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SKILL_READ))
    .input(adminSkillListVersionsInputSchema)
    .output(adminSkillListVersionsOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await createSkillService(ctx.serverDB).listVersions(input);
      } catch (error) {
        return mapSkillServiceError(error);
      }
    }),

  /**
   * Parse a skill package from URL / GitHub repo / uploaded ZIP without persisting anything.
   * Read-only preview for the admin import flow; publish org-wide via applyImmediate.
   */
  parseImportSource: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SKILL_CREATE))
    .input(adminSkillParseImportSourceInputSchema)
    .output(adminSkillParseImportSourceOutputSchema)
    .mutation(async ({ input }) => {
      assertSkillFeatureEnabled();
      return parseSkillImportSource(input);
    }),

  publish: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SKILL_PUBLISH))
    .input(adminSkillPublishInputSchema)
    .output(adminSkillPublicationOutputSchema)
    .mutation(async ({ ctx, input }) => {
      assertSkillFeatureEnabled();
      await assertSkillDangerousReauth({
        action: 'admin.skills.publish',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        serverDB: ctx.serverDB,
        targetId: input.id,
      });
      try {
        return await createSkillService(ctx.serverDB).publish(ctx.userId!, input);
      } catch (error) {
        return mapSkillServiceError(error);
      }
    }),

  rollback: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SKILL_PUBLISH))
    .input(adminSkillRollbackInputSchema)
    .output(adminSkillPublicationOutputSchema)
    .mutation(async ({ ctx, input }) => {
      assertSkillFeatureEnabled();
      await assertSkillDangerousReauth({
        action: 'admin.skills.rollback',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        reason: input.reason,
        serverDB: ctx.serverDB,
        targetId: input.id,
      });
      try {
        return await createSkillService(ctx.serverDB).rollback(ctx.userId!, input);
      } catch (error) {
        return mapSkillServiceError(error);
      }
    }),

  updateDraft: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SKILL_UPDATE))
    .input(adminSkillUpdateDraftInputSchema)
    .output(adminSkillMutationOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await createSkillService(ctx.serverDB).updateDraft(ctx.userId!, input);
      } catch (error) {
        return mapSkillServiceError(error);
      }
    }),

  validate: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.SKILL_UPDATE))
    .input(adminSkillValidateInputSchema)
    .output(adminSkillValidateOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await createSkillService(ctx.serverDB).validate(ctx.userId!, input);
      } catch (error) {
        return mapSkillServiceError(error);
      }
    }),
});
