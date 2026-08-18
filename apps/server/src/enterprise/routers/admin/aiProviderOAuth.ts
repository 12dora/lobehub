import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';

import debug from 'debug';
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
import { extractChatGPTAccountEmail } from '@/server/services/oauthDeviceFlow/providers/chatGPT';
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
import { readSharedOAuthReauthMarker } from '../../services/aiCatalog/sharedOAuthReauthMarker';
import {
  isOAuthAuthorizationExpiredError,
  refreshSharedOAuthVault,
} from '../../services/aiCatalog/sharedOAuthRefresh';
import { PlatformBrowserProfileService } from '../../services/browserProfile';
import { wipeChatGPTWebCookieJar } from '../../services/chatgptWeb/oauthService';
import { PlatformAuditService } from '../../services/platformAudit';
import { assertDangerousReauth, createService, mapServiceError } from './aiCatalogSupport';
import {
  acquireSharedConnectionTokens,
  asVaultString,
  auditProvider,
  buildSharedVault,
  disconnectPermissions,
  INITIATE_REAUTH_REASON,
  maskAccountId,
  resolveRenewalKind,
  resolveRotatingOAuthCard,
  sharedAccountPermissions,
} from './aiProviderOAuthSupport';

const log = debug('lobe-server:admin-ai-provider-oauth');

/**
 * Device id for the ChatGPT Web jar, persisted beside the jar itself.
 *
 * apply commits the vault clear and then a post-commit getDetail can fail
 * because the database went away. The verification read then fails too, and a
 * retry sees an empty vault. The id has to live outside the row or the jar is
 * stranded while a historical revision can still resolve its secret version.
 */
const CHATGPT_WEB_PENDING_WIPE_DIR = nodePath.join(tmpdir(), 'aihub-chatgptweb-jars');

const chatgptWebPendingWipePath = (providerId: string) =>
  nodePath.join(CHATGPT_WEB_PENDING_WIPE_DIR, `pending-wipe-${providerId}`);

const persistChatGPTWebPendingWipe = (providerId: string, deviceId: string): void => {
  try {
    mkdirSync(CHATGPT_WEB_PENDING_WIPE_DIR, { mode: 0o700, recursive: true });
    writeFileSync(chatgptWebPendingWipePath(providerId), deviceId, { mode: 0o600 });
  } catch {
    // Best-effort: the in-memory capture still covers this request.
  }
};

const readChatGPTWebPendingWipe = (providerId: string): string | undefined => {
  try {
    const deviceId = readFileSync(chatgptWebPendingWipePath(providerId), 'utf8').trim();
    return deviceId || undefined;
  } catch {
    return undefined;
  }
};

const clearChatGPTWebPendingWipe = (providerId: string): void => {
  try {
    unlinkSync(chatgptWebPendingWipePath(providerId));
  } catch {
    // Already gone.
  }
};

const decryptChatGPTWebDeviceId = async (
  ciphertext: string | null | undefined,
): Promise<string | undefined> => {
  if (!ciphertext) return undefined;
  const secrets = PlatformSecretService.fromEnvOrThrowIfEnterprise();
  if (!secrets) return undefined;
  const keyVaults = await new AiCatalogSecretManager(secrets).decrypt(ciphertext);
  return asVaultString(keyVaults.oauthDeviceId);
};

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
        try {
          const provider = await repo.getProvider(detail.draft.id);
          chatgptWebDeviceId = await decryptChatGPTWebDeviceId(provider?.encryptedKeyVaults);
          if (!chatgptWebDeviceId) {
            const published = await repo.getLatestPublishedProviderRevision(detail.draft.id);
            if (published?.secretFingerprint) {
              const version = await repo.getProviderSecretVersion(
                detail.draft.id,
                published.secretFingerprint,
              );
              chatgptWebDeviceId = await decryptChatGPTWebDeviceId(version?.ciphertext);
            }
          }
        } catch {
          // Best-effort: never fail the disconnect on a vault-read error.
        }
        chatgptWebDeviceId ??= readChatGPTWebPendingWipe(detail.draft.id);
      }

      const wipeCapturedJar = () => {
        const deviceId = chatgptWebDeviceId ?? readChatGPTWebPendingWipe(detail.draft.id);
        if (!deviceId) return;
        try {
          wipeChatGPTWebCookieJar(deviceId);
        } catch {
          // Best-effort: never fail the disconnect on a jar unlink.
        }
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
        type ClearOutcome = { revision: number } | 'live' | 'unknown';
        let outcome: ClearOutcome;
        try {
          const provider = await repo.getProvider(detail.draft.id);
          outcome = provider?.encryptedKeyVaults
            ? 'live'
            : { revision: provider?.revision ?? detail.baseRevision };
        } catch {
          outcome = 'unknown';
        }

        if (outcome === 'live') {
          clearChatGPTWebPendingWipe(detail.draft.id);
        } else {
          wipeCapturedJar();
        }

        if (typeof outcome === 'object') {
          clearChatGPTWebPendingWipe(detail.draft.id);
          await auditProvider(audit, {
            action: 'admin.aiProviderOAuth.disconnect',
            actorUserId: ctx.userId!,
            afterDiff: { providerKey: input.id, revision: outcome.revision },
            result: 'success',
            targetId: detail.draft.id,
          });
          return { disconnected: true, revision: outcome.revision };
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
      let keyVaults = await secretManager.decrypt(provider.encryptedKeyVaults);

      // Renew before projecting. Rotation used to happen ONLY on a real chat execution, so an
      // operator opening this card saw a stale (often already expired) timestamp until someone
      // chatted. This runs the same lease + CAS machinery, and is a cheap no-op while the
      // token is still fresh.
      let expired = false;
      if (provider.secretFingerprint) {
        try {
          keyVaults = await refreshSharedOAuthVault({
            ciphertext: provider.encryptedKeyVaults,
            db: ctx.serverDB,
            fingerprint: provider.secretFingerprint,
            keyVaults,
            providerKey: input.id,
            providerRowId: provider.id,
            secrets: secretManager,
          });
        } catch (error) {
          // Only a dead grant is actionable for the operator. Everything else (network, token
          // endpoint 5xx, lost lease) degrades to the stored values — the card still renders.
          if (isOAuthAuthorizationExpiredError(error)) expired = true;
          // Stable category + provider key only. This path is polled by any admin with
          // AI_PROVIDER_READ, and a refresh failure carries provider-controlled prose
          // (`error_description`) that must never be copied into logs.
          else log('status refresh for %s degraded to stored values', input.id);
        }
      }

      const accessToken = asVaultString(keyVaults.oauthAccessToken);
      const accountId = asVaultString(keyVaults.oauthAccountId);
      const expiresAt = asVaultString(keyVaults.oauthTokenExpiresAt);
      // Raw epoch-ms string, exactly like `expiresAt`: both mirror the vault leaf type, and
      // formatting belongs to the panel that renders them in the operator's locale.
      const lastRefreshAt = asVaultString(keyVaults.oauthLastRefreshAt);
      // Connections stored before the email leaf existed keep working: decode the claim from
      // the access token we already hold, best-effort and WITHOUT persisting it.
      //
      // Gated on the credential SHAPE. A provider whose vault has no `oauthAccountEmail`
      // (SuperGrok) deliberately does not surface an account identity, and decoding a
      // standard `email` claim out of its token would publish exactly what that shape
      // withholds — to every admin with AI_PROVIDER_READ.
      const emailProjectable = providerCredentialKeys(input.id).has('oauthAccountEmail');
      const accountEmail = emailProjectable
        ? (asVaultString(keyVaults.oauthAccountEmail) ??
          extractChatGPTAccountEmail(undefined, accessToken) ??
          null)
        : null;

      const refreshCredential = asVaultString(keyVaults.oauthRefreshToken);
      /**
       * Terminal auth failures recorded by the refresh path or by a real execution through the
       * shared account. This is what closes the gap the operator kept hitting: a token string
       * sitting in the vault, unexpired, that chatgpt.com has already stopped accepting — the
       * refresh above is a no-op in that state, so presence alone said "已连接" while every
       * member's chat came back 需要重新授权.
       */
      const marker = readSharedOAuthReauthMarker(keyVaults);

      return {
        accountEmail,
        accountIdMasked: maskAccountId(accountId),
        // A pasted access token has no renewal credential at all: it dies at `expiresAt` and
        // only a manual reconnect brings it back. A web session counts — it mints fresh
        // access tokens exactly like an OAuth refresh token does.
        canRefresh: Boolean(refreshCredential),
        connected: !expired && Boolean(accessToken),
        expired,
        expiresAt: expiresAt ?? null,
        flow: getProviderOAuthGrantFlow(input.id),
        // Null unless `needsReauth` — the pair is written and cleared as a unit.
        invalidAt: expired ? (marker.invalidAt ?? String(Date.now())) : marker.invalidAt,
        invalidReason: expired ? (marker.invalidReason ?? 'invalidGrant') : marker.invalidReason,
        // Stamped at connect and moved forward by every successful renewal (including the
        // one this query just ran), so an operator can tell a connection that is quietly
        // rolling over from one nothing has touched since it was made.
        lastRefreshAt: lastRefreshAt ?? null,
        /**
         * `expired` is this request's own observation (the refresh above threw `invalid_grant`);
         * the marker is what an EARLIER observation — from any instance, including a member's
         * failing chat — wrote down. Either one means the same thing to the operator, so they
         * are surfaced as one state instead of two badges nobody can tell apart.
         */
        needsReauth: expired || Boolean(marker.invalidAt),
        /**
         * Names the renewal path so the panel can say WHY the connection keeps working.
         * The stored label wins; connections made before the leaf existed are identified by
         * the credential's shape (a next-auth session JWE is unmistakable), and anything
         * else is the OAuth refresh token it can only be.
         */
        renewalKind: refreshCredential ? resolveRenewalKind(keyVaults, refreshCredential) : null,
        secretConfigured,
      };
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
      const acquired = await acquireSharedConnectionTokens({
        actorUserId: ctx.userId!,
        audit,
        browserProfile,
        card,
        input,
        targetId,
      });
      if (acquired.kind === 'result') return acquired.result;
      const connectionTokens = acquired.tokens;

      const { clearedLeaves: clearedIdentityLeaves, vault } = buildSharedVault(
        input.id,
        connectionTokens,
      );

      let result;
      try {
        result = detail
          ? await service.applyProviderImmediate(ctx.userId!, {
              expectedDraftToken: detail.draftToken,
              expectedRevision: detail.baseRevision,
              id: detail.draft.id,
              mode: 'update',
              reason: input.reason,
              secret: {
                operation: 'merge',
                ...(clearedIdentityLeaves.length > 0 ? { unset: clearedIdentityLeaves } : {}),
                value: vault,
              },
            })
          : await service.applyProviderImmediate(ctx.userId!, {
              // Without a check model the admin connectivity probe cannot run at all; the
              // builtin card already names the right default.
              checkModel: card.checkModel ?? null,
              description: card.description,
              displayName: card.name,
              // Connecting a shared account IS the activation intent, and the row is created
              // here for the first time — so first connect lands enabled and live. The update
              // branch above deliberately omits `enabled`: a reconnect must never re-enable a
              // provider the admin turned off on purpose.
              enabled: true,
              mode: 'create',
              providerKey: input.id,
              reason: input.reason,
              secret: { operation: 'replace', value: vault },
              settings: card.settings,
              source: 'builtin',
            });
      } catch {
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
