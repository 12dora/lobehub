/**
 * admin.creds — platform-owned global credentials (kv / file).
 * Procedure names and inputs mirror market.creds subset for CredsApi UI reuse.
 * M13: get never returns plaintext secret material.
 */
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import {
  adminCredsCreateFileInputSchema,
  adminCredsCreateKvInputSchema,
  adminCredsCreateOauthInputSchema,
  adminCredsDeleteOutputSchema,
  adminCredsGetByKeyInputSchema,
  adminCredsGetInputSchema,
  adminCredsGetOutputSchema,
  adminCredsIdInputSchema,
  adminCredsKeyInputSchema,
  adminCredsListOutputSchema,
  adminCredsOauthConnectionsOutputSchema,
  adminCredsSkillStatusInputSchema,
  adminCredsSkillStatusOutputSchema,
  adminCredsSummaryOutputSchema,
  adminCredsUpdateInputSchema,
  adminCredsUploadFileInputSchema,
  adminCredsUploadFileOutputSchema,
} from '../../contracts/adminCreds';
import { withActiveUser } from '../../guards/activeUser';
import { withAdminMutationRateLimit } from '../../guards/adminMutationRateLimit';
import { withPlatformPermission } from '../../guards/platformPermission';
import { assertDangerousReauth, createCredsService, mapCredsServiceError } from './credsSupport';

const adminBase = authedProcedure
  .use(serverDatabase)
  .use(withActiveUser())
  .use(withAdminMutationRateLimit());

const readProcedure = adminBase.use(withPlatformPermission(PLATFORM_PERMISSIONS.CRED_READ));
const createProcedure = adminBase.use(withPlatformPermission(PLATFORM_PERMISSIONS.CRED_CREATE));
const updateProcedure = adminBase.use(withPlatformPermission(PLATFORM_PERMISSIONS.CRED_UPDATE));
const deleteProcedure = adminBase.use(withPlatformPermission(PLATFORM_PERMISSIONS.CRED_DELETE));

export const adminCredsRouter = router({
  createFile: createProcedure
    .input(adminCredsCreateFileInputSchema)
    .output(adminCredsSummaryOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertDangerousReauth({
        action: 'admin.creds.createFile',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        serverDB: ctx.serverDB,
        targetId: input.key,
      });
      try {
        return await createCredsService(ctx.serverDB).createFile({
          actorUserId: ctx.userId!,
          description: input.description,
          fileHashId: input.fileHashId,
          fileName: input.fileName,
          key: input.key,
          name: input.name,
        });
      } catch (error) {
        return mapCredsServiceError(error);
      }
    }),

  createKV: createProcedure
    .input(adminCredsCreateKvInputSchema)
    .output(adminCredsSummaryOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertDangerousReauth({
        action: 'admin.creds.createKV',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        serverDB: ctx.serverDB,
        targetId: input.key,
      });
      try {
        return await createCredsService(ctx.serverDB).createKV({
          actorUserId: ctx.userId!,
          description: input.description,
          key: input.key,
          name: input.name,
          type: input.type,
          values: input.values,
        });
      } catch (error) {
        return mapCredsServiceError(error);
      }
    }),

  createOAuth: createProcedure
    .input(adminCredsCreateOauthInputSchema)
    .output(adminCredsSummaryOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertDangerousReauth({
        action: 'admin.creds.createOAuth',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        serverDB: ctx.serverDB,
        targetId: input.key,
      });
      try {
        return await createCredsService(ctx.serverDB).createOAuth();
      } catch (error) {
        return mapCredsServiceError(error);
      }
    }),

  delete: deleteProcedure
    .input(adminCredsIdInputSchema)
    .output(adminCredsDeleteOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertDangerousReauth({
        action: 'admin.creds.delete',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        serverDB: ctx.serverDB,
        targetId: String(input.id),
      });
      try {
        return await createCredsService(ctx.serverDB).delete({
          actorUserId: ctx.userId!,
          id: input.id,
        });
      } catch (error) {
        return mapCredsServiceError(error);
      }
    }),

  deleteByKey: deleteProcedure
    .input(adminCredsKeyInputSchema)
    .output(adminCredsDeleteOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertDangerousReauth({
        action: 'admin.creds.deleteByKey',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        serverDB: ctx.serverDB,
        targetId: input.key,
      });
      try {
        return await createCredsService(ctx.serverDB).deleteByKey({
          actorUserId: ctx.userId!,
          key: input.key,
        });
      } catch (error) {
        return mapCredsServiceError(error);
      }
    }),

  get: readProcedure
    .input(adminCredsGetInputSchema)
    .output(adminCredsGetOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await createCredsService(ctx.serverDB).get(input);
      } catch (error) {
        return mapCredsServiceError(error);
      }
    }),

  getByKey: readProcedure
    .input(adminCredsGetByKeyInputSchema)
    .output(adminCredsGetOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await createCredsService(ctx.serverDB).getByKey(input);
      } catch (error) {
        return mapCredsServiceError(error);
      }
    }),

  getSkillCredStatus: readProcedure
    .input(adminCredsSkillStatusInputSchema)
    .output(adminCredsSkillStatusOutputSchema)
    .query(async ({ ctx, input }) => {
      return createCredsService(ctx.serverDB).getSkillCredStatus(input.skillIdentifier);
    }),

  list: readProcedure.output(adminCredsListOutputSchema).query(async ({ ctx }) => {
    return createCredsService(ctx.serverDB).list();
  }),

  listOAuthConnections: readProcedure
    .output(adminCredsOauthConnectionsOutputSchema)
    .query(async ({ ctx }) => createCredsService(ctx.serverDB).listOAuthConnections()),

  update: updateProcedure
    .input(adminCredsUpdateInputSchema)
    .output(adminCredsSummaryOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertDangerousReauth({
        action: 'admin.creds.update',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        serverDB: ctx.serverDB,
        targetId: String(input.id),
      });
      try {
        return await createCredsService(ctx.serverDB).update({
          actorUserId: ctx.userId!,
          description: input.description,
          expectedRevision: input.expectedRevision,
          fileHashId: input.fileHashId,
          fileName: input.fileName,
          id: input.id,
          name: input.name,
          values: input.values,
        });
      } catch (error) {
        return mapCredsServiceError(error);
      }
    }),

  uploadFile: createProcedure
    .input(adminCredsUploadFileInputSchema)
    .output(adminCredsUploadFileOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertDangerousReauth({
        action: 'admin.creds.uploadFile',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        serverDB: ctx.serverDB,
        targetId: input.fileName,
      });
      try {
        return await createCredsService(ctx.serverDB).uploadFile({
          actorUserId: ctx.userId!,
          fileBase64: input.file,
          fileName: input.fileName,
          fileType: input.fileType,
        });
      } catch (error) {
        return mapCredsServiceError(error);
      }
    }),
});
