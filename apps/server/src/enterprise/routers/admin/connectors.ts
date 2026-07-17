import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import {
  adminConnectorArchiveInputSchema,
  adminConnectorCreateDraftInputSchema,
  adminConnectorDeleteDraftInputSchema,
  adminConnectorDeleteDraftOutputSchema,
  adminConnectorDiscoverInputSchema,
  adminConnectorDiscoverOutputSchema,
  adminConnectorDraftMutationOutputSchema,
  adminConnectorGetInputSchema,
  adminConnectorGetOutputSchema,
  adminConnectorListInputSchema,
  adminConnectorListOutputSchema,
  adminConnectorPublishInputSchema,
  adminConnectorRevisionOutputSchema,
  adminConnectorRevokeAllBindingsInputSchema,
  adminConnectorRevokeAllBindingsOutputSchema,
  adminConnectorRollbackInputSchema,
  adminConnectorTestInputSchema,
  adminConnectorTestOutputSchema,
  adminConnectorUpdateDraftInputSchema,
} from '../../contracts/platformConnectors';
import { withActiveUser } from '../../guards/activeUser';
import { withPlatformPermission } from '../../guards/platformPermission';
import {
  assertAdminConnectorRuntimeDependency,
  assertConnectorDangerousReauth,
  connectorSecretMutationRequiresReauth,
  createAdminConnectorRuntime,
  executeAdminConnectorOperation,
  resolveAdminConnectorMutationRuntime,
} from './connectorsSupport';

const adminConnectorProcedure = authedProcedure
  .use(serverDatabase)
  .use(withActiveUser())
  .use(async ({ ctx, next }) =>
    next({
      ctx: {
        getAdminConnectorRuntime: () => createAdminConnectorRuntime(ctx.serverDB),
      },
    }),
  );

const replacementSecrets = (input: {
  oauthClientSecret?: { operation: string; value?: unknown };
  reason: string;
  sharedSecret?: { operation: string; value?: unknown };
}): unknown[] => [
  ...(input.oauthClientSecret?.operation === 'replace' ? [input.oauthClientSecret.value] : []),
  ...(input.sharedSecret?.operation === 'replace' ? [input.sharedSecret.value] : []),
];

export const adminConnectorsRouter = router({
  archive: adminConnectorProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.CONNECTOR_DELETE))
    .input(adminConnectorArchiveInputSchema)
    .output(adminConnectorRevisionOutputSchema)
    .mutation(async ({ ctx, input }) =>
      executeAdminConnectorOperation('admin.connectors.archive', async () => {
        const runtime = await resolveAdminConnectorMutationRuntime({
          action: 'admin.connectors.archive',
          actorUserId: ctx.userId!,
          createRuntime: ctx.getAdminConnectorRuntime,
          reason: input.reason,
          serverDB: ctx.serverDB,
          targetId: input.id,
        });
        await assertConnectorDangerousReauth({
          action: 'admin.connectors.archive',
          actorUserId: ctx.userId!,
          authenticatedAt: ctx.authenticatedAt,
          authMethod: ctx.authMethod,
          reason: input.reason,
          runtime,
          serverDB: ctx.serverDB,
          targetId: input.id,
        });
        return runtime.service.archive(ctx.userId!, input);
      }),
    ),

  createDraft: adminConnectorProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.CONNECTOR_CREATE))
    .input(adminConnectorCreateDraftInputSchema)
    .output(adminConnectorDraftMutationOutputSchema)
    .mutation(async ({ ctx, input }) =>
      executeAdminConnectorOperation('admin.connectors.createDraft', async () => {
        const runtime = await resolveAdminConnectorMutationRuntime({
          action: 'admin.connectors.createDraft',
          actorUserId: ctx.userId!,
          createRuntime: ctx.getAdminConnectorRuntime,
          reason: input.reason,
          replacementSecrets: replacementSecrets(input),
          serverDB: ctx.serverDB,
          targetId: input.key,
        });
        const dangerous =
          connectorSecretMutationRequiresReauth(
            input.credentialMode === 'per_user_oauth' ? input.oauthClientSecret : undefined,
          ) ||
          connectorSecretMutationRequiresReauth(
            input.credentialMode === 'shared_service_account' ? input.sharedSecret : undefined,
          );
        if (dangerous) {
          await assertConnectorDangerousReauth({
            action: 'admin.connectors.createDraft',
            actorUserId: ctx.userId!,
            authenticatedAt: ctx.authenticatedAt,
            authMethod: ctx.authMethod,
            reason: input.reason,
            replacementSecrets: replacementSecrets(input),
            runtime,
            serverDB: ctx.serverDB,
            targetId: input.key,
          });
        }
        if (input.credentialMode === 'per_user_oauth') {
          await assertAdminConnectorRuntimeDependency({
            action: 'admin.connectors.createDraft',
            actorUserId: ctx.userId!,
            category: 'redirect_unavailable',
            operation: runtime.resolveRedirectUri,
            reason: input.reason,
            replacementSecrets: replacementSecrets(input),
            runtime,
            serverDB: ctx.serverDB,
            targetId: input.key,
          });
        }
        return runtime.service.createDraft(ctx.userId!, input);
      }),
    ),

  deleteDraft: adminConnectorProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.CONNECTOR_DELETE))
    .input(adminConnectorDeleteDraftInputSchema)
    .output(adminConnectorDeleteDraftOutputSchema)
    .mutation(async ({ ctx, input }) =>
      executeAdminConnectorOperation('admin.connectors.deleteDraft', async () => {
        const runtime = await resolveAdminConnectorMutationRuntime({
          action: 'admin.connectors.deleteDraft',
          actorUserId: ctx.userId!,
          createRuntime: ctx.getAdminConnectorRuntime,
          reason: input.reason,
          serverDB: ctx.serverDB,
          targetId: input.id,
        });
        return runtime.service.deleteDraft(ctx.userId!, input);
      }),
    ),

  discover: adminConnectorProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.CONNECTOR_TEST))
    .input(adminConnectorDiscoverInputSchema)
    .output(adminConnectorDiscoverOutputSchema)
    .mutation(async ({ ctx, input }) =>
      executeAdminConnectorOperation('admin.connectors.discover', async () => {
        const runtime = await resolveAdminConnectorMutationRuntime({
          action: 'admin.connectors.discover',
          actorUserId: ctx.userId!,
          createRuntime: ctx.getAdminConnectorRuntime,
          reason: input.reason,
          serverDB: ctx.serverDB,
          targetId: input.id,
        });
        await assertAdminConnectorRuntimeDependency({
          action: 'admin.connectors.discover',
          actorUserId: ctx.userId!,
          category: 'transport_unavailable',
          operation: runtime.assertOutboundPolicyReady,
          reason: input.reason,
          runtime,
          serverDB: ctx.serverDB,
          targetId: input.id,
        });
        return runtime.service.discover(ctx.userId!, input);
      }),
    ),

  get: adminConnectorProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.CONNECTOR_READ))
    .input(adminConnectorGetInputSchema)
    .output(adminConnectorGetOutputSchema)
    .query(async ({ ctx, input }) =>
      executeAdminConnectorOperation('admin.connectors.get', () =>
        ctx.getAdminConnectorRuntime().service.getDraft(input.id),
      ),
    ),

  list: adminConnectorProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.CONNECTOR_READ))
    .input(adminConnectorListInputSchema)
    .output(adminConnectorListOutputSchema)
    .query(async ({ ctx, input }) =>
      executeAdminConnectorOperation('admin.connectors.list', () =>
        ctx.getAdminConnectorRuntime().service.listDrafts(input),
      ),
    ),

  publish: adminConnectorProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.CONNECTOR_PUBLISH))
    .input(adminConnectorPublishInputSchema)
    .output(adminConnectorRevisionOutputSchema)
    .mutation(async ({ ctx, input }) =>
      executeAdminConnectorOperation('admin.connectors.publish', async () => {
        const runtime = await resolveAdminConnectorMutationRuntime({
          action: 'admin.connectors.publish',
          actorUserId: ctx.userId!,
          createRuntime: ctx.getAdminConnectorRuntime,
          reason: input.reason,
          serverDB: ctx.serverDB,
          targetId: input.id,
        });
        await assertConnectorDangerousReauth({
          action: 'admin.connectors.publish',
          actorUserId: ctx.userId!,
          authenticatedAt: ctx.authenticatedAt,
          authMethod: ctx.authMethod,
          reason: input.reason,
          runtime,
          serverDB: ctx.serverDB,
          targetId: input.id,
        });
        await assertAdminConnectorRuntimeDependency({
          action: 'admin.connectors.publish',
          actorUserId: ctx.userId!,
          category: 'transport_unavailable',
          operation: runtime.assertOutboundPolicyReady,
          reason: input.reason,
          runtime,
          serverDB: ctx.serverDB,
          targetId: input.id,
        });
        return runtime.service.publish(ctx.userId!, input);
      }),
    ),

  revokeAllBindings: adminConnectorProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.CONNECTOR_DELETE))
    .input(adminConnectorRevokeAllBindingsInputSchema)
    .output(adminConnectorRevokeAllBindingsOutputSchema)
    .mutation(async ({ ctx, input }) =>
      executeAdminConnectorOperation('admin.connectors.revokeAllBindings', async () => {
        const runtime = await resolveAdminConnectorMutationRuntime({
          action: 'admin.connectors.revokeAllBindings',
          actorUserId: ctx.userId!,
          createRuntime: ctx.getAdminConnectorRuntime,
          reason: input.reason,
          serverDB: ctx.serverDB,
          targetId: input.id,
        });
        await assertConnectorDangerousReauth({
          action: 'admin.connectors.revokeAllBindings',
          actorUserId: ctx.userId!,
          authenticatedAt: ctx.authenticatedAt,
          authMethod: ctx.authMethod,
          reason: input.reason,
          runtime,
          serverDB: ctx.serverDB,
          targetId: input.id,
        });
        return runtime.service.revokeAllBindings(ctx.userId!, input);
      }),
    ),

  rollback: adminConnectorProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.CONNECTOR_PUBLISH))
    .input(adminConnectorRollbackInputSchema)
    .output(adminConnectorRevisionOutputSchema)
    .mutation(async ({ ctx, input }) =>
      executeAdminConnectorOperation('admin.connectors.rollback', async () => {
        const runtime = await resolveAdminConnectorMutationRuntime({
          action: 'admin.connectors.rollback',
          actorUserId: ctx.userId!,
          createRuntime: ctx.getAdminConnectorRuntime,
          reason: input.reason,
          serverDB: ctx.serverDB,
          targetId: input.id,
        });
        await assertConnectorDangerousReauth({
          action: 'admin.connectors.rollback',
          actorUserId: ctx.userId!,
          authenticatedAt: ctx.authenticatedAt,
          authMethod: ctx.authMethod,
          reason: input.reason,
          runtime,
          serverDB: ctx.serverDB,
          targetId: input.id,
        });
        await assertAdminConnectorRuntimeDependency({
          action: 'admin.connectors.rollback',
          actorUserId: ctx.userId!,
          category: 'transport_unavailable',
          operation: runtime.assertOutboundPolicyReady,
          reason: input.reason,
          runtime,
          serverDB: ctx.serverDB,
          targetId: input.id,
        });
        return runtime.service.rollback(ctx.userId!, input);
      }),
    ),

  test: adminConnectorProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.CONNECTOR_TEST))
    .input(adminConnectorTestInputSchema)
    .output(adminConnectorTestOutputSchema)
    .mutation(async ({ ctx, input }) =>
      executeAdminConnectorOperation('admin.connectors.test', async () => {
        const runtime = await resolveAdminConnectorMutationRuntime({
          action: 'admin.connectors.test',
          actorUserId: ctx.userId!,
          createRuntime: ctx.getAdminConnectorRuntime,
          reason: input.reason,
          serverDB: ctx.serverDB,
          targetId: input.id,
        });
        await assertAdminConnectorRuntimeDependency({
          action: 'admin.connectors.test',
          actorUserId: ctx.userId!,
          category: 'transport_unavailable',
          operation: runtime.assertOutboundPolicyReady,
          reason: input.reason,
          runtime,
          serverDB: ctx.serverDB,
          targetId: input.id,
        });
        return runtime.service.testConnection(ctx.userId!, input);
      }),
    ),

  updateDraft: adminConnectorProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.CONNECTOR_UPDATE))
    .input(adminConnectorUpdateDraftInputSchema)
    .output(adminConnectorDraftMutationOutputSchema)
    .mutation(async ({ ctx, input }) =>
      executeAdminConnectorOperation('admin.connectors.updateDraft', async () => {
        const runtime = await resolveAdminConnectorMutationRuntime({
          action: 'admin.connectors.updateDraft',
          actorUserId: ctx.userId!,
          createRuntime: ctx.getAdminConnectorRuntime,
          reason: input.reason,
          replacementSecrets: replacementSecrets(input),
          serverDB: ctx.serverDB,
          targetId: input.id,
        });
        const current = await runtime.service.getDraft(input.id);
        const targetMode = input.credentialMode ?? current.draft.credentialMode;
        const clearsExistingMode =
          input.credentialMode !== undefined &&
          input.credentialMode !== current.draft.credentialMode &&
          current.draft.credentialMode !== 'none';
        const dangerous =
          clearsExistingMode ||
          connectorSecretMutationRequiresReauth(input.oauthClientSecret) ||
          connectorSecretMutationRequiresReauth(input.sharedSecret);
        if (dangerous) {
          await assertConnectorDangerousReauth({
            action: 'admin.connectors.updateDraft',
            actorUserId: ctx.userId!,
            authenticatedAt: ctx.authenticatedAt,
            authMethod: ctx.authMethod,
            reason: input.reason,
            replacementSecrets: replacementSecrets(input),
            runtime,
            serverDB: ctx.serverDB,
            targetId: input.id,
          });
        }
        if (targetMode === 'per_user_oauth') {
          await assertAdminConnectorRuntimeDependency({
            action: 'admin.connectors.updateDraft',
            actorUserId: ctx.userId!,
            category: 'redirect_unavailable',
            operation: runtime.resolveRedirectUri,
            reason: input.reason,
            replacementSecrets: replacementSecrets(input),
            runtime,
            serverDB: ctx.serverDB,
            targetId: input.id,
          });
        }
        return runtime.service.updateDraft(ctx.userId!, input);
      }),
    ),
});

export type AdminConnectorsRouter = typeof adminConnectorsRouter;
