import type { z } from 'zod';

import { PlatformAiCatalogRepository } from '@/database/repositories/platformAiCatalog';

import type { adminAiProviderOAuthDisconnectInputSchema } from '../../contracts/aiProviderOAuth';
import { AiCatalogNotFoundError } from '../../services/aiCatalog/adminService';
import { buildChatGPTWebBrowserSessionAccountId } from '../../services/chatgptWeb/oauthService';
import { PlatformAuditService } from '../../services/platformAudit';
import { assertDangerousReauth, createService, mapServiceError } from './aiCatalogSupport';
import type { AiProviderOAuthCtx } from './aiProviderOAuth.ctx';
import { auditProvider, resolveRotatingOAuthCard } from './aiProviderOAuthSupport';
import {
  captureChatGPTWebDeviceId,
  clearChatGPTWebPendingWipe,
  persistChatGPTWebPendingWipe,
  readChatGPTWebPendingWipe,
  recoverDisconnectAfterApplyFailure,
  wipeChatGPTWebJarBestEffort,
} from './chatgptWebDisconnectWipe';

type DisconnectInput = z.infer<typeof adminAiProviderOAuthDisconnectInputSchema>;

export const disconnectSharedProviderAccount = async ({
  ctx,
  input,
}: {
  ctx: AiProviderOAuthCtx;
  input: DisconnectInput;
}) => {
  // Admission first: an unsupported provider is rejected before any audit row exists.
  resolveRotatingOAuthCard(input.id);

  const service = createService(ctx.serverDB);
  // Read-only lookup: gives the CAS baseline and the denial audit a stored credential
  // to sanitize the operator reason against.
  let detail;
  try {
    detail = await service.getDetail({ providerKey: input.id });
  } catch (error) {
    if (!(error instanceof AiCatalogNotFoundError)) return mapServiceError(error);
  }

  // Gate before the branch below: the freshness requirement is a property of the
  // action, never of how much state happens to exist.
  await assertDangerousReauth({
    action: 'admin.aiProviderOAuth.disconnect',
    actorUserId: ctx.userId!,
    authenticatedAt: ctx.authenticatedAt,
    authMethod: ctx.authMethod,
    existingSecretTargetId: detail?.draft.id ?? null,
    reason: input.reason,
    serverDB: ctx.serverDB,
    targetId: detail?.draft.id ?? input.id,
  });

  // Nothing was ever connected: idempotent no-op, and no audit row for a write that
  // did not happen.
  if (!detail) return { disconnected: false, revision: null };

  const repo = new PlatformAiCatalogRepository(ctx.serverDB);

  // Device id first, while a vault (live or the still-published revision) may
  // still hold it. The apply below clears the row; a later retry cannot
  // reconstruct this from an empty vault.
  let chatgptWebDeviceId: string | undefined;
  if (input.id === 'chatgptweb') {
    chatgptWebDeviceId = await captureChatGPTWebDeviceId({
      draftId: detail.draft.id,
      repo,
    });
  }

  const wipeCapturedJar = () => {
    wipeChatGPTWebJarBestEffort(
      chatgptWebDeviceId ?? readChatGPTWebPendingWipe(detail.draft.id),
      buildChatGPTWebBrowserSessionAccountId({
        kind: 'platform',
        providerId: input.id,
      }),
    );
  };

  // Fail-closed: a draft-only clear leaves the published revision's secret
  // live. An unread published row is treated as still holding one.
  const publishedHasSecret = await repo
    .getLatestPublishedProviderRevision(detail.draft.id)
    .then((published) => Boolean(published?.secretFingerprint))
    .catch(() => true);

  // Already withdrawn at both draft and published. Republishing would mint
  // another immutable revision and another success audit for an authorization
  // that is not there; a lost response plus a client retry is enough.
  if (!detail.draft.secret.configured && !publishedHasSecret) {
    wipeCapturedJar();
    clearChatGPTWebPendingWipe(detail.draft.id);
    return { disconnected: true, revision: detail.baseRevision };
  }

  if (chatgptWebDeviceId) persistChatGPTWebPendingWipe(detail.draft.id, chatgptWebDeviceId);

  const audit = new PlatformAuditService(ctx.serverDB);
  let result;
  try {
    result = await service.applyProviderImmediate(ctx.userId!, {
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: detail.draft.id,
      mode: 'update',
      reason: input.reason,
      // `clear` (not merge+unset): the vault of these providers holds OAuth leaves
      // only, and an empty `merge.value` is rejected by the credential schema. It also
      // makes the status query short-circuit on `secretConfigured: false`.
      secret: { operation: 'clear' },
    });
  } catch (error) {
    // The failure we recover from is usually a post-commit getDetail outage, so
    // a second database read is likely to fail too. Wipe from the id captured
    // before apply whenever we cannot prove the session is still live.
    const recovery = await recoverDisconnectAfterApplyFailure({
      baseRevision: detail.baseRevision,
      capturedDeviceId: chatgptWebDeviceId,
      draftId: detail.draft.id,
      repo,
    });

    if (recovery.kind === 'cleared') {
      await auditProvider(audit, {
        action: 'admin.aiProviderOAuth.disconnect',
        actorUserId: ctx.userId!,
        afterDiff: { providerKey: input.id, revision: recovery.revision },
        result: 'success',
        targetId: detail.draft.id,
      });
      return { disconnected: true, revision: recovery.revision };
    }

    await auditProvider(audit, {
      action: 'admin.aiProviderOAuth.disconnect',
      actorUserId: ctx.userId!,
      // Service errors may carry issue prose — only a stable code is stored.
      afterDiff: { error: 'provider_store_failed', providerKey: input.id },
      result: 'failure',
      targetId: detail.draft.id,
    });
    return mapServiceError(error);
  }

  wipeCapturedJar();
  clearChatGPTWebPendingWipe(detail.draft.id);

  await auditProvider(audit, {
    action: 'admin.aiProviderOAuth.disconnect',
    actorUserId: ctx.userId!,
    // Stable outcome codes only — never the withdrawn account identity.
    afterDiff: { providerKey: input.id, revision: result.revision },
    result: 'success',
    targetId: result.draft?.id ?? detail.draft.id,
  });

  return { disconnected: true, revision: result.revision };
};
