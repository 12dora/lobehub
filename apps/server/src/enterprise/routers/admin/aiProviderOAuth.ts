import {
  getProviderOAuthGrantFlow,
  isProviderAccessTokenPasteAllowed,
} from 'model-bank/modelProviders';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { PlatformAiCatalogRepository } from '@/database/repositories/platformAiCatalog';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';
import { PlatformSecretService } from '@/server/enterprise/security/secret';
import { getOAuthService } from '@/server/services/oauthDeviceFlow/providers/githubCopilot';

import {
  adminAiProviderOAuthDisconnectInputSchema,
  adminAiProviderOAuthDisconnectOutputSchema,
  adminAiProviderOAuthInitiateInputSchema,
  adminAiProviderOAuthInitiateOutputSchema,
  adminAiProviderOAuthPollInputSchema,
  adminAiProviderOAuthPollOutputSchema,
  adminAiProviderOAuthStatusInputSchema,
  adminAiProviderOAuthStatusOutputSchema,
} from '../../contracts/aiProviderOAuth';
import { withActiveUser } from '../../guards/activeUser';
import { withAdminMutationRateLimit } from '../../guards/adminMutationRateLimit';
import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import {
  withAllPlatformPermissions,
  withPlatformPermission,
} from '../../guards/platformPermission';
import { AiCatalogNotFoundError } from '../../services/aiCatalog/adminService';
import { providerCredentialKeys } from '../../services/aiCatalog/credentialAdapter';
import { AiCatalogSecretManager } from '../../services/aiCatalog/secretManager';
import { tryBackfillSharedAccountIdentity } from '../../services/aiCatalog/sharedOAuthIdentity';
import { PlatformBrowserProfileService } from '../../services/browserProfile';
import { buildChatGPTWebBrowserSessionAccountId } from '../../services/chatgptWeb/oauthService';
import { PlatformAuditService } from '../../services/platformAudit';
import { assertDangerousReauth, createService, mapServiceError } from './aiCatalogSupport';
import {
  acquireSharedConnectionTokens,
  applySharedConnectionVault,
  auditProvider,
  buildSharedVault,
  disconnectPermissions,
  INITIATE_REAUTH_REASON,
  maskAccountId,
  projectSharedConnectionStatus,
  refreshStatusVault,
  resolveRotatingOAuthCard,
  sharedAccountPermissions,
} from './aiProviderOAuthSupport';
import {
  captureChatGPTWebDeviceId,
  clearChatGPTWebPendingWipe,
  persistChatGPTWebPendingWipe,
  readChatGPTWebPendingWipe,
  recoverDisconnectAfterApplyFailure,
  wipeChatGPTWebJarBestEffort,
} from './chatgptWebDisconnectWipe';

const adminBase = authedProcedure
  .use(serverDatabase)
  .use(withActiveUser())
  .use(withAdminMutationRateLimit());

export const adminAiProviderOAuthRouter = router({
  /**
   * Withdraw the shared platform account: clear the vault and publish, leaving the
   * provider row, its models, and its `enabled` flag untouched.
   *
   * `enabled` is deliberately left alone. `assertRemovedModelsUnused` treats a flip
   * to `enabled: false` as removing every published enabled model of this provider,
   * so any published agent or setting that pins one of them (the normal state of a
   * shared account) rolls the whole write back with PLATFORM_RESOURCE_IN_USE.
   * Clearing the vault while staying enabled is a no-op for that check; members
   * then fall back to their own credentials because a secret-less published
   * provider is omitted from the runtime projection.
   *
   * NOT a revocation at the authorization server: the provider-side grant stays valid until
   * it expires or is revoked in the provider's own console. The copy must not imply otherwise.
   */
  disconnect: adminBase
    .use(withAllPlatformPermissions([...disconnectPermissions]))
    .input(adminAiProviderOAuthDisconnectInputSchema)
    .output(adminAiProviderOAuthDisconnectOutputSchema)
    .mutation(async ({ ctx, input }) => {
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
    }),

  /**
   * Read the shared connection state of one rotating-refresh provider.
   * Presence + expiry + masked account only; token material never leaves the server.
   */
  getConnectionStatus: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AI_PROVIDER_READ))
    .input(adminAiProviderOAuthStatusInputSchema)
    .output(adminAiProviderOAuthStatusOutputSchema)
    .query(async ({ ctx, input }) => {
      resolveRotatingOAuthCard(input.id);

      const disconnected = {
        accountEmail: null,
        accountIdMasked: null,
        canRefresh: false,
        connected: false,
        expired: false,
        expiresAt: null,
        flow: getProviderOAuthGrantFlow(input.id),
        invalidAt: null,
        invalidReason: null,
        needsReauth: false,
        renewalKind: null,
        secretConfigured: false,
      };

      let detail;
      try {
        detail = await createService(ctx.serverDB).getDetail({ providerKey: input.id });
      } catch (error) {
        if (error instanceof AiCatalogNotFoundError) return disconnected;
        return mapServiceError(error);
      }

      const secretConfigured = detail.draft.secret.configured;
      if (!secretConfigured) return disconnected;

      const provider = await new PlatformAiCatalogRepository(ctx.serverDB).getProvider(
        detail.draft.id,
      );
      if (!provider?.encryptedKeyVaults) {
        return { ...disconnected, secretConfigured };
      }

      const secrets = PlatformSecretService.fromEnvOrThrowIfEnterprise();
      if (!secrets) {
        return throwEnterpriseError({
          code: PLATFORM_ERROR_CODES.PLATFORM_SECRET_REQUIRED,
          httpCode: 'PRECONDITION_FAILED',
        });
      }
      const secretManager = new AiCatalogSecretManager(secrets);
      const keyVaults = await secretManager.decrypt(provider.encryptedKeyVaults);

      // Renew before projecting. Rotation used to happen ONLY on a real chat execution, so an
      // operator opening this card saw a stale (often already expired) timestamp until someone
      // chatted. This runs the same lease + CAS machinery, and is a cheap no-op while the
      // token is still fresh.
      const refreshed = await refreshStatusVault({
        db: ctx.serverDB,
        keyVaults,
        provider: {
          encryptedKeyVaults: provider.encryptedKeyVaults,
          id: provider.id,
          secretFingerprint: provider.secretFingerprint,
        },
        providerKey: input.id,
        secretManager,
      });

      const status = projectSharedConnectionStatus({
        expired: refreshed.expired,
        flow: getProviderOAuthGrantFlow(input.id),
        keyVaults: refreshed.keyVaults,
        providerKey: input.id,
        secretConfigured,
      });

      if (
        status.connected &&
        !status.accountEmail &&
        providerCredentialKeys(input.id).has('oauthAccountEmail')
      ) {
        try {
          const backfilled = await tryBackfillSharedAccountIdentity({
            db: ctx.serverDB,
            providerKey: input.id,
            providerRowId: provider.id,
            secrets: secretManager,
          });
          if (backfilled?.email) status.accountEmail = backfilled.email;
          if (backfilled?.accountId) status.accountIdMasked = maskAccountId(backfilled.accountId);
        } catch {
          // Identity backfill must never take the status card down.
        }
      }

      return status;
    }),

  /**
   * Request a device code for the shared platform account.
   * Persists nothing — only the sanitized audit trail of the attempt.
   *
   * Reauth is asserted on THIS step rather than only on the store: it is the click-driven
   * one, so a step-up prompt still has user activation, and a session fresh here covers the
   * whole device-code lifetime. A later poll can then never redeem the single-use grant
   * with a session it is about to reject.
   */
  initiateDeviceCode: adminBase
    .use(withAllPlatformPermissions([...sharedAccountPermissions]))
    .input(adminAiProviderOAuthInitiateInputSchema)
    .output(adminAiProviderOAuthInitiateOutputSchema)
    .mutation(async ({ ctx, input }) => {
      // Admission first: an unsupported provider is rejected before any audit row exists.
      const card = resolveRotatingOAuthCard(input.id);

      await assertDangerousReauth({
        action: 'admin.aiProviderOAuth.initiateDeviceCode',
        actorUserId: ctx.userId!,
        authenticatedAt: ctx.authenticatedAt,
        authMethod: ctx.authMethod,
        // Constant reason, no stored secret to scan against.
        existingSecretTargetId: null,
        reason: INITIATE_REAUTH_REASON,
        serverDB: ctx.serverDB,
        targetId: input.id,
      });

      const audit = new PlatformAuditService(ctx.serverDB);

      let response;
      try {
        const browserProfile =
          getProviderOAuthGrantFlow(input.id) === 'authorization_code_paste'
            ? await new PlatformBrowserProfileService(ctx.serverDB).getOrFallback()
            : undefined;
        response = await getOAuthService(
          input.id,
          browserProfile ? { browserProfile } : undefined,
        ).initiateDeviceCode(card.config);
      } catch {
        await auditProvider(audit, {
          action: 'admin.aiProviderOAuth.initiateDeviceCode',
          actorUserId: ctx.userId!,
          // Provider prose may echo request material — only a stable code is stored.
          afterDiff: { error: 'device_code_request_failed', providerKey: input.id },
          result: 'failure',
          targetId: input.id,
        });
        return throwEnterpriseError({
          code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
          httpCode: 'PRECONDITION_FAILED',
        });
      }

      await auditProvider(audit, {
        action: 'admin.aiProviderOAuth.initiateDeviceCode',
        actorUserId: ctx.userId!,
        afterDiff: { providerKey: input.id },
        result: 'success',
        targetId: input.id,
      });

      return {
        allowAccessTokenPaste: isProviderAccessTokenPasteAllowed(input.id),
        deviceCode: response.deviceCode,
        expiresIn: Number.isFinite(response.expiresIn) ? response.expiresIn : null,
        flow: getProviderOAuthGrantFlow(input.id),
        interval: response.interval,
        userCode: response.userCode,
        verificationUri: response.verificationUri,
        verificationUriComplete: response.verificationUriComplete ?? null,
      };
    }),

  /**
   * Poll the authorization server once (the client drives the retry cadence) and,
   * on authorization, store the shared connection in the platform vault.
   *
   * The reauth freshness check runs BEFORE the token exchange: the device grant is
   * single-use, so a tick that could not store the result must not redeem it. Apart from
   * that check (which audits only when it denies) a tick that finds no authorization yet
   * writes nothing.
   *
   * Storing applies immediately (the service publishes unconditionally): a `stored: true`
   * result means the credentials are committed, while the provider's existing `enabled` state
   * is preserved. If the store fails after the grant was redeemed the poll returns
   * a terminal `denied` outcome with a stable code rather than throwing.
   */
  pollAuthStatus: adminBase
    .use(withAllPlatformPermissions([...sharedAccountPermissions]))
    .input(adminAiProviderOAuthPollInputSchema)
    .output(adminAiProviderOAuthPollOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const card = resolveRotatingOAuthCard(input.id);
      const unfinished = { error: null, revision: null, stored: false };
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
    }),
});
