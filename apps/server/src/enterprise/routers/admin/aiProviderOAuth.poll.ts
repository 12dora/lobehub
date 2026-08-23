import { getProviderOAuthGrantFlow } from 'model-bank/modelProviders';
import type { z } from 'zod';

import { PlatformAiCatalogRepository } from '@/database/repositories/platformAiCatalog';

import type { adminAiProviderOAuthPollInputSchema } from '../../contracts/aiProviderOAuth';
import { AiCatalogNotFoundError } from '../../services/aiCatalog/adminService';
import { PlatformBrowserProfileService } from '../../services/browserProfile';
import { PlatformAuditService } from '../../services/platformAudit';
import { assertDangerousReauth, createService, mapServiceError } from './aiCatalogSupport';
import type { AiProviderOAuthCtx } from './aiProviderOAuth.ctx';
import {
  acquireSharedConnectionTokens,
  applySharedConnectionVault,
  auditProvider,
  buildSharedVault,
  resolveRotatingOAuthCard,
} from './aiProviderOAuthSupport';
import { unfinishedPollResult } from './aiProviderOAuthSupport.acquireTypes';
import { captureChatGPTWebDeviceId, wipeChatGPTWebJarBestEffort } from './chatgptWebDisconnectWipe';

type PollInput = z.infer<typeof adminAiProviderOAuthPollInputSchema>;

export const pollSharedAuthStatus = async ({
  ctx,
  input,
}: {
  ctx: AiProviderOAuthCtx;
  input: PollInput;
}) => {
  const card = resolveRotatingOAuthCard(input.id);
  const unfinished = unfinishedPollResult;
  const audit = new PlatformAuditService(ctx.serverDB);

  // Read-only lookup: decides the create-vs-update branch and gives the denial audit a
  // stored credential to sanitize the operator reason against.
  const service = createService(ctx.serverDB);
  let detail;
  try {
    detail = await service.getDetail({ providerKey: input.id });
  } catch (error) {
    if (!(error instanceof AiCatalogNotFoundError)) return mapServiceError(error);
  }
  const targetId = detail?.draft.id ?? input.id;

  await assertDangerousReauth({
    action: 'admin.aiProviderOAuth.pollAuthStatus',
    actorUserId: ctx.userId!,
    authenticatedAt: ctx.authenticatedAt,
    authMethod: ctx.authMethod,
    existingSecretTargetId: detail?.draft.id ?? null,
    reason: input.reason,
    serverDB: ctx.serverDB,
    targetId,
  });

  const browserProfile =
    getProviderOAuthGrantFlow(input.id) === 'authorization_code_paste'
      ? await new PlatformBrowserProfileService(ctx.serverDB).getOrFallback()
      : undefined;
  const existingDeviceId = detail
    ? await captureChatGPTWebDeviceId({
        draftId: detail.draft.id,
        repo: new PlatformAiCatalogRepository(ctx.serverDB),
      })
    : undefined;
  const acquired = await acquireSharedConnectionTokens({
    actorUserId: ctx.userId!,
    audit,
    browserProfile,
    card,
    ...(existingDeviceId ? { existingDeviceId } : {}),
    input,
    targetId,
  });
  if (acquired.kind === 'result') return acquired.result;
  const connectionTokens = acquired.tokens;
  const browserSession = acquired.browserSession;

  const { clearedLeaves: clearedIdentityLeaves, vault } = buildSharedVault(
    input.id,
    connectionTokens,
  );

  let result;
  try {
    result = await applySharedConnectionVault({
      card,
      clearedIdentityLeaves,
      detail,
      providerKey: input.id,
      reason: input.reason,
      service,
      userId: ctx.userId!,
      vault,
    });
  } catch {
    // Persist failed: drop the staged candidate and leave the live context
    // untouched. Promoting first would mix the new session cookie with the
    // still-old vault credential.
    browserSession?.discardVerifiedChatGPTWebSession();
    // The device grant is single-use and has already been redeemed here, so a failed
    // store must not crash the poll loop: report a terminal, non-retryable outcome and
    // let the operator start a fresh authorization. Only a stable code is surfaced —
    // service errors may carry issue prose that never belongs on this boundary.
    await auditProvider(audit, {
      action: 'admin.aiProviderOAuth.pollAuthStatus',
      actorUserId: ctx.userId!,
      afterDiff: {
        error: 'provider_store_failed',
        mode: detail ? 'update' : 'create',
        providerKey: input.id,
      },
      result: 'failure',
      targetId,
    });
    return { ...unfinished, error: 'provider_store_failed', status: 'denied' as const };
  }
  browserSession?.commitVerifiedChatGPTWebSession(connectionTokens.deviceId);

  // Leftover device-id-keyed jar only. Commit+rotate have already moved
  // this account identity onto the new context; wiping by account id here
  // would invalidate the connection that was just stored.
  if (
    existingDeviceId &&
    connectionTokens.deviceId &&
    existingDeviceId !== connectionTokens.deviceId
  ) {
    wipeChatGPTWebJarBestEffort(existingDeviceId);
  }

  await auditProvider(audit, {
    action: 'admin.aiProviderOAuth.pollAuthStatus',
    actorUserId: ctx.userId!,
    // Stable outcome codes only — the vault leaves this procedure through the service.
    afterDiff: {
      mode: detail ? 'update' : 'create',
      providerKey: input.id,
      revision: result.revision,
    },
    result: 'success',
    targetId: result.draft?.id ?? targetId,
  });

  return {
    error: null,
    revision: result.revision,
    status: 'success' as const,
    stored: true,
  };
};
