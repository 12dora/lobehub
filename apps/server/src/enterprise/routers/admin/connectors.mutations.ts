import type { z } from 'zod';

import type {
  adminConnectorApplyImmediateInputSchema,
  adminConnectorArchiveInputSchema,
  adminConnectorCreateDraftInputSchema,
  adminConnectorDeleteDraftInputSchema,
  adminConnectorDiscoverInputSchema,
  adminConnectorPublishInputSchema,
  adminConnectorPublishNowInputSchema,
  adminConnectorRevokeAllBindingsInputSchema,
  adminConnectorRollbackInputSchema,
  adminConnectorTestInputSchema,
  adminConnectorUpdateDraftInputSchema,
} from '../../contracts/platformConnectors';
import type { AdminConnectorCtx } from './connectors.procedure';
import { replacementSecrets } from './connectors.procedure';
import {
  assertAdminConnectorRuntimeDependency,
  assertConnectorDangerousReauth,
  connectorSecretMutationRequiresReauth,
  executeAdminConnectorOperation,
  resolveAdminConnectorMutationRuntime,
} from './connectorsSupport';

export const applyImmediate = async ({
  ctx,
  input,
}: {
  ctx: AdminConnectorCtx;
  input: z.infer<typeof adminConnectorApplyImmediateInputSchema>;
}) =>
  executeAdminConnectorOperation('admin.connectors.applyImmediate', async () => {
    const targetId = input.mode === 'create' ? input.key : input.id;
    const secrets = replacementSecrets(input as Parameters<typeof replacementSecrets>[0]);
    const runtime = await resolveAdminConnectorMutationRuntime({
      action: 'admin.connectors.applyImmediate',
      actorUserId: ctx.userId!,
      createRuntime: ctx.getAdminConnectorRuntime,
      reason: input.reason,
      replacementSecrets: secrets,
      serverDB: ctx.serverDB,
      targetId,
    });
    await assertConnectorDangerousReauth({
      action: 'admin.connectors.applyImmediate',
      actorUserId: ctx.userId!,
      authenticatedAt: ctx.authenticatedAt,
      authMethod: ctx.authMethod,
      reason: input.reason,
      replacementSecrets: secrets,
      runtime,
      serverDB: ctx.serverDB,
      targetId,
    });
    if (input.mode === 'create' && input.credentialMode === 'per_user_oauth') {
      await assertAdminConnectorRuntimeDependency({
        action: 'admin.connectors.applyImmediate',
        actorUserId: ctx.userId!,
        category: 'redirect_unavailable',
        operation: runtime.resolveRedirectUri,
        reason: input.reason,
        replacementSecrets: secrets,
        runtime,
        serverDB: ctx.serverDB,
        targetId,
      });
    }
    await assertAdminConnectorRuntimeDependency({
      action: 'admin.connectors.applyImmediate',
      actorUserId: ctx.userId!,
      category: 'transport_unavailable',
      operation: runtime.assertOutboundPolicyReady,
      reason: input.reason,
      replacementSecrets: secrets,
      runtime,
      serverDB: ctx.serverDB,
      targetId,
    });
    return runtime.service.applyImmediate(ctx.userId!, input);
  });

export const publishNow = async ({
  ctx,
  input,
}: {
  ctx: AdminConnectorCtx;
  input: z.infer<typeof adminConnectorPublishNowInputSchema>;
}) =>
  executeAdminConnectorOperation('admin.connectors.publishNow', async () => {
    const runtime = await resolveAdminConnectorMutationRuntime({
      action: 'admin.connectors.publishNow',
      actorUserId: ctx.userId!,
      createRuntime: ctx.getAdminConnectorRuntime,
      reason: input.reason,
      serverDB: ctx.serverDB,
      targetId: input.id,
    });
    await assertConnectorDangerousReauth({
      action: 'admin.connectors.publishNow',
      actorUserId: ctx.userId!,
      authenticatedAt: ctx.authenticatedAt,
      authMethod: ctx.authMethod,
      reason: input.reason,
      runtime,
      serverDB: ctx.serverDB,
      targetId: input.id,
    });
    await assertAdminConnectorRuntimeDependency({
      action: 'admin.connectors.publishNow',
      actorUserId: ctx.userId!,
      category: 'transport_unavailable',
      operation: runtime.assertOutboundPolicyReady,
      reason: input.reason,
      runtime,
      serverDB: ctx.serverDB,
      targetId: input.id,
    });
    return runtime.service.publishNow(ctx.userId!, input);
  });

export const archive = async ({
  ctx,
  input,
}: {
  ctx: AdminConnectorCtx;
  input: z.infer<typeof adminConnectorArchiveInputSchema>;
}) =>
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
  });

export const createDraft = async ({
  ctx,
  input,
}: {
  ctx: AdminConnectorCtx;
  input: z.infer<typeof adminConnectorCreateDraftInputSchema>;
}) =>
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
  });

export const deleteDraft = async ({
  ctx,
  input,
}: {
  ctx: AdminConnectorCtx;
  input: z.infer<typeof adminConnectorDeleteDraftInputSchema>;
}) =>
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
  });

export const discover = async ({
  ctx,
  input,
}: {
  ctx: AdminConnectorCtx;
  input: z.infer<typeof adminConnectorDiscoverInputSchema>;
}) =>
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
  });

export const publish = async ({
  ctx,
  input,
}: {
  ctx: AdminConnectorCtx;
  input: z.infer<typeof adminConnectorPublishInputSchema>;
}) =>
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
  });

export const revokeAllBindings = async ({
  ctx,
  input,
}: {
  ctx: AdminConnectorCtx;
  input: z.infer<typeof adminConnectorRevokeAllBindingsInputSchema>;
}) =>
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
  });

export const rollback = async ({
  ctx,
  input,
}: {
  ctx: AdminConnectorCtx;
  input: z.infer<typeof adminConnectorRollbackInputSchema>;
}) =>
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
  });

export const testConnection = async ({
  ctx,
  input,
}: {
  ctx: AdminConnectorCtx;
  input: z.infer<typeof adminConnectorTestInputSchema>;
}) =>
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
  });

export const updateDraft = async ({
  ctx,
  input,
}: {
  ctx: AdminConnectorCtx;
  input: z.infer<typeof adminConnectorUpdateDraftInputSchema>;
}) =>
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
  });
