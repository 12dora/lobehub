/**
 * admin.creds — platform-owned global credentials (kv / file).
 * Procedure names and inputs mirror market.creds subset for CredsApi UI reuse.
 * M13: get never returns plaintext secret material.
 */
import { z } from 'zod';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { PLATFORM_GLOBAL_CREDENTIAL_MAX_FILE_BYTES } from '@/database/schemas/platform';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import { withActiveUser } from '../../guards/activeUser';
import { withAdminMutationRateLimit } from '../../guards/adminMutationRateLimit';
import { withPlatformPermission } from '../../guards/platformPermission';
import { assertDangerousReauth, createCredsService, mapCredsServiceError } from './credsSupport';

/** Base64 expands 3 bytes → 4 chars; bound encoded length before Buffer.from. */
const MAX_UPLOAD_BASE64_CHARS = Math.ceil(PLATFORM_GLOBAL_CREDENTIAL_MAX_FILE_BYTES / 3) * 4;

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
    .input(
      z.object({
        description: z.string().optional(),
        fileHashId: z.string().length(64),
        fileName: z.string().min(1),
        key: z.string().min(1).max(100),
        name: z.string().min(1).max(255),
      }),
    )
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
    .input(
      z.object({
        description: z.string().optional(),
        key: z.string().min(1).max(100),
        name: z.string().min(1).max(255),
        type: z.enum(['kv-env', 'kv-header']),
        values: z.record(z.string()),
      }),
    )
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
    .input(
      z.object({
        description: z.string().optional(),
        key: z.string().min(1).max(100),
        name: z.string().min(1).max(255),
        oauthConnectionId: z.number(),
      }),
    )
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

  delete: deleteProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
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
    .input(z.object({ key: z.string() }))
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
    .input(
      z.object({
        decrypt: z.boolean().optional(),
        id: z.number(),
      }),
    )
    .query(async ({ ctx, input }) => {
      try {
        return await createCredsService(ctx.serverDB).get(input);
      } catch (error) {
        return mapCredsServiceError(error);
      }
    }),

  getByKey: readProcedure
    .input(
      z.object({
        decrypt: z.boolean().optional(),
        key: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      try {
        return await createCredsService(ctx.serverDB).getByKey(input);
      } catch (error) {
        return mapCredsServiceError(error);
      }
    }),

  getSkillCredStatus: readProcedure
    .input(z.object({ skillIdentifier: z.string() }))
    .query(async ({ ctx, input }) => {
      return createCredsService(ctx.serverDB).getSkillCredStatus(input.skillIdentifier);
    }),

  list: readProcedure.query(async ({ ctx }) => {
    return createCredsService(ctx.serverDB).list();
  }),

  listOAuthConnections: readProcedure.query(async ({ ctx }) => {
    return createCredsService(ctx.serverDB).listOAuthConnections();
  }),

  update: updateProcedure
    .input(
      z.object({
        description: z.string().optional(),
        expectedRevision: z.number().int().min(0),
        /** Owner-bound staged upload id (SHA-256) for file secret rotation. */
        fileHashId: z.string().length(64).optional(),
        fileName: z.string().min(1).optional(),
        id: z.number(),
        name: z.string().optional(),
        values: z.record(z.string()).optional(),
      }),
    )
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
    .input(
      z.object({
        file: z
          .string()
          .max(MAX_UPLOAD_BASE64_CHARS)
          .regex(
            /^(?:[A-Z\d+/]{4})*(?:[A-Z\d+/]{2}==|[A-Z\d+/]{3}=)?$/i,
            'Invalid base64 file payload',
          ),
        fileName: z.string().min(1),
        fileType: z.string().min(1),
      }),
    )
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
