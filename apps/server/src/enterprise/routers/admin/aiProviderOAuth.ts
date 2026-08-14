import debug from 'debug';
import { ModelProvider } from 'model-bank';
import {
  DEFAULT_MODEL_PROVIDER_LIST,
  isRotatingRefreshOAuthProvider,
} from 'model-bank/modelProviders';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { PlatformAiCatalogRepository } from '@/database/repositories/platformAiCatalog';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';
import { PlatformSecretService } from '@/server/enterprise/security/secret';
import { parseJwtExpiry } from '@/server/services/oauthDeviceFlow';
import { extractChatGPTAccountEmail } from '@/server/services/oauthDeviceFlow/providers/chatGPT';
import { getOAuthService } from '@/server/services/oauthDeviceFlow/providers/githubCopilot';
import type { OAuthDeviceFlowConfig } from '@/types/aiProvider';

import {
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
import { AiCatalogSecretManager } from '../../services/aiCatalog/secretManager';
import {
  isOAuthAuthorizationExpiredError,
  refreshSharedOAuthVault,
} from '../../services/aiCatalog/sharedOAuthRefresh';
import { PlatformAuditService } from '../../services/platformAudit';
import { assertDangerousReauth, createService, mapServiceError } from './aiCatalogSupport';

const log = debug('lobe-server:admin-ai-provider-oauth');

const adminBase = authedProcedure
  .use(serverDatabase)
  .use(withActiveUser())
  .use(withAdminMutationRateLimit());

interface RotatingOAuthProviderCard {
  /** Builtin default probe model, seeded so admin connectivity check works on first connect. */
  checkModel?: string;
  config: OAuthDeviceFlowConfig;
  description?: string;
  name: string;
  settings: Record<string, unknown>;
}

/**
 * Resolve the builtin card of a provider whose device flow issues ROTATING refresh
 * tokens. Only these providers may hold a shared platform account: an API-key style
 * credential is never valid for them, and whoever stores the token owns its refresh
 * lifecycle. Everything else (including GitHub Copilot) is rejected here.
 */
const resolveRotatingOAuthCard = (providerKey: string): RotatingOAuthProviderCard => {
  const card = DEFAULT_MODEL_PROVIDER_LIST.find((provider) => provider.id === providerKey);
  const config = card?.settings?.oauthDeviceFlow;

  if (!card || !config || !isRotatingRefreshOAuthProvider(providerKey)) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
      httpCode: 'PRECONDITION_FAILED',
    });
  }

  return {
    checkModel: card.checkModel,
    config,
    description: card.description,
    name: card.name,
    settings: (card.settings ?? {}) as Record<string, unknown>,
  };
};

/** Recognition affordance only — never enough material to reconstruct the account id. */
const maskAccountId = (accountId: string | undefined): string | null =>
  accountId ? `${accountId.slice(0, 4)}…` : null;

/** Platform vaults hold string leaves; header maps and absent leaves are not projectable. */
const asVaultString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/**
 * Reason recorded on the reauth denial of the initiate step. The contract carries no
 * operator reason there (nothing is persisted), so a server constant is used — it can
 * never contain secret material.
 */
const INITIATE_REAUTH_REASON = 'Request a device authorization code for a shared provider account.';

/**
 * The device grant is single-use and every branch below reaches the shared platform
 * credential, so both procedures require the union of the create and update branches.
 * Create-vs-update is decided by server state (does the platform row exist yet), not by
 * client input, and an operator who may open the flow must be able to finish it.
 */
const sharedAccountPermissions = [
  PLATFORM_PERMISSIONS.AI_PROVIDER_CREATE,
  PLATFORM_PERMISSIONS.AI_PROVIDER_UPDATE,
  PLATFORM_PERMISSIONS.AI_PROVIDER_PUBLISH,
] as const;

export const adminAiProviderOAuthRouter = router({
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
        connected: false,
        expired: false,
        expiresAt: null,
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
      // Connections stored before the email leaf existed keep working: decode the claim from
      // the access token we already hold, best-effort and WITHOUT persisting it.
      const accountEmail =
        asVaultString(keyVaults.oauthAccountEmail) ??
        extractChatGPTAccountEmail(undefined, accessToken) ??
        null;

      return {
        accountEmail,
        accountIdMasked: maskAccountId(accountId),
        connected: !expired && Boolean(accessToken),
        expired,
        expiresAt: expiresAt ?? null,
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
        response = await getOAuthService(input.id).initiateDeviceCode(card.config);
      } catch {
        await audit.append({
          action: 'admin.aiProviderOAuth.initiateDeviceCode',
          actorUserId: ctx.userId!,
          // Provider prose may echo request material — only a stable code is stored.
          afterDiff: { error: 'device_code_request_failed', providerKey: input.id },
          result: 'failure',
          targetId: input.id,
          targetType: 'provider',
        });
        return throwEnterpriseError({
          code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
          httpCode: 'PRECONDITION_FAILED',
        });
      }

      await audit.append({
        action: 'admin.aiProviderOAuth.initiateDeviceCode',
        actorUserId: ctx.userId!,
        afterDiff: { providerKey: input.id },
        result: 'success',
        targetId: input.id,
        targetType: 'provider',
      });

      return {
        deviceCode: response.deviceCode,
        expiresIn: Number.isFinite(response.expiresIn) ? response.expiresIn : null,
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
   * Storing applies immediately (the service publishes unconditionally), so a `stored: true`
   * result is always live. If the store fails after the grant was redeemed the poll returns
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

      let pollResult;
      try {
        pollResult = await getOAuthService(input.id).pollForToken(card.config, input.deviceCode);
      } catch {
        await audit.append({
          action: 'admin.aiProviderOAuth.pollAuthStatus',
          actorUserId: ctx.userId!,
          // Provider prose may echo request material — only a stable code is stored.
          afterDiff: { error: 'device_token_exchange_failed', providerKey: input.id },
          result: 'failure',
          targetId,
          targetType: 'provider',
        });
        return throwEnterpriseError({
          code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
          httpCode: 'PRECONDITION_FAILED',
        });
      }

      if (pollResult.status !== 'success' || !pollResult.tokens) {
        return { ...unfinished, status: pollResult.status };
      }

      const tokens = pollResult.tokens;
      // Expiry: prefer the explicit expires_in, fall back to the JWT exp claim —
      // some providers (e.g. xAI) don't always return expires_in.
      const expiresAt = tokens.expiresIn
        ? Date.now() + tokens.expiresIn * 1000
        : parseJwtExpiry(tokens.accessToken);
      const vault: Record<string, string> = { oauthAccessToken: tokens.accessToken };
      if (tokens.refreshToken) vault.oauthRefreshToken = tokens.refreshToken;
      // Only ChatGPT's credential shape accepts an account id; supergrok rejects the key.
      if (input.id === ModelProvider.ChatGPT && tokens.accountId) {
        vault.oauthAccountId = tokens.accountId;
      }
      // Display-only account identity, same credential shape rule as the account id.
      if (input.id === ModelProvider.ChatGPT && tokens.email) {
        vault.oauthAccountEmail = tokens.email;
      }
      if (expiresAt) vault.oauthTokenExpiresAt = String(expiresAt);

      /**
       * Identity leaves move as a UNIT with the credential they describe. A reconnect that
       * returns no email claim must clear the stored one — a merge alone would leave the
       * PREVIOUS account's email displayed next to the new account's token.
       */
      const clearedIdentityLeaves =
        input.id === ModelProvider.ChatGPT && !tokens.email ? ['oauthAccountEmail'] : [];

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
        await audit.append({
          action: 'admin.aiProviderOAuth.pollAuthStatus',
          actorUserId: ctx.userId!,
          afterDiff: {
            error: 'provider_store_failed',
            mode: detail ? 'update' : 'create',
            providerKey: input.id,
          },
          result: 'failure',
          targetId,
          targetType: 'provider',
        });
        return { ...unfinished, error: 'provider_store_failed', status: 'denied' as const };
      }

      await audit.append({
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
        targetType: 'provider',
      });

      return {
        error: null,
        revision: result.revision,
        status: 'success' as const,
        stored: true,
      };
    }),
});
