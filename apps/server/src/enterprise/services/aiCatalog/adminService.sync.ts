import type { ChatModelCard } from 'model-bank';
import { isProviderOAuthDeviceFlow } from 'model-bank/modelProviders';

import { PlatformAiCatalogRepository } from '@/database/repositories/platformAiCatalog';
import type { PlatformAiProviderSettings } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';
import {
  buildPayloadFromKeyVaults,
  initModelRuntimeWithUserPayload,
  resolvePlatformBrowserProfile,
} from '@/server/modules/ModelRuntime';

import { PlatformAuditService } from '../platformAudit';
import { AiCatalogAdminServiceModelOps } from './adminService.models';
import { applyProviderCatalogSyncPolicy, mapCardsToBatchUpdate } from './adminService.sync.mapping';
import { aiConnectionFailureCode, classifyAiConnectionFailure } from './connectionTestService';
import { normalizeAiCatalogExecutionCredentials } from './credentialAdapter';
import {
  AiCatalogCannotEnumerateError,
  AiCatalogNotFoundError,
  AiCatalogUpstreamSyncError,
  AiCatalogValidationError,
} from './errors';
import type { AiCatalogSecretManager, PlatformProviderKeyVaults } from './secretManager';
import {
  isOAuthAuthorizationExpiredError,
  isSharedOAuthRefreshConsumedError,
  refreshSharedOAuthVault,
  type RefreshSharedOAuthVaultParams,
} from './sharedOAuthRefresh';

export {
  applyChatGPTWebCatalogSyncPolicy,
  mapCardsToBatchUpdate,
} from './adminService.sync.mapping';

const SYNC_UPSTREAM_REASON = 'Sync models from upstream';

const toUpstreamSyncError = (error: unknown): AiCatalogUpstreamSyncError => {
  if (error instanceof AiCatalogUpstreamSyncError) return error;
  const failure = classifyAiConnectionFailure(error);
  const errorType = isOAuthAuthorizationExpiredError(error)
    ? 'OAuthAuthorizationExpired'
    : failure.errorType;
  return new AiCatalogUpstreamSyncError({
    errorCategory: failure.errorCategory,
    errorType,
    message: aiConnectionFailureCode(failure.errorCategory, errorType),
  });
};

const refreshVaultForUpstreamSync = async (
  params: RefreshSharedOAuthVaultParams,
): Promise<PlatformProviderKeyVaults> => {
  try {
    return await refreshSharedOAuthVault(params);
  } catch (error) {
    if (isOAuthAuthorizationExpiredError(error) || isSharedOAuthRefreshConsumedError(error)) {
      throw toUpstreamSyncError(error);
    }
    // Token-endpoint blip before the rotating token is spent — the still-valid
    // access token may list models. Persist failures after exchange are terminal.
    return params.keyVaults;
  }
};

const assertSharedAccountConnected = (
  provider: { providerKey: string; settings: PlatformAiProviderSettings },
  refreshed: Record<string, unknown>,
) => {
  const isSharedAccountProvider =
    provider.settings.authType === 'oauthDeviceFlow' ||
    isProviderOAuthDeviceFlow(provider.providerKey);
  const accessToken =
    typeof refreshed.oauthAccessToken === 'string' ? refreshed.oauthAccessToken : undefined;
  if (isSharedAccountProvider && !accessToken) {
    throw new AiCatalogValidationError(
      ['Shared account is not connected'],
      'shared_account_not_connected',
    );
  }
};

/**
 * Decrypt the draft platform vault, refresh a rotating grant if needed, and list
 * models through the same runtime chat uses. Does not go through
 * `resolvePlatformAiExecutionConfig` — that throws unless 平台托管 is published.
 */
export const enumeratePlatformUpstreamModels = async (params: {
  browserProfile?: Awaited<ReturnType<typeof resolvePlatformBrowserProfile>>;
  keyVaults: Record<string, unknown>;
  providerKey: string;
  runtimeProvider: string;
}): Promise<ChatModelCard[]> => {
  const payload = buildPayloadFromKeyVaults(
    params.keyVaults as Parameters<typeof buildPayloadFromKeyVaults>[0],
    params.runtimeProvider,
  );
  const runtime = initModelRuntimeWithUserPayload(params.providerKey, payload, {
    ...(params.browserProfile ? { browserProfile: params.browserProfile } : {}),
    conversationKey: `platform:sync-upstream:${params.providerKey}`,
    managedBy: 'platform',
  });
  let listed: ChatModelCard[] | undefined;
  try {
    listed = await runtime.models();
  } catch (error) {
    throw toUpstreamSyncError(error);
  }
  if (!Array.isArray(listed)) throw new AiCatalogCannotEnumerateError();
  return listed;
};

/**
 * Model-sync surface of {@link AiCatalogAdminService}.
 * Split from the provider / model-mutation surfaces to stay under the ~800-line guideline.
 */
export abstract class AiCatalogAdminServiceSyncOps extends AiCatalogAdminServiceModelOps {
  protected abstract readonly db: LobeChatDatabase;
  protected abstract readonly secrets: AiCatalogSecretManager;

  syncUpstream = async (actorUserId: string, input: { providerId: string }) => {
    const reason = await this.sanitizeReason(SYNC_UPSTREAM_REASON);
    let targetId: string | undefined;
    try {
      const detail = await this.resolveProviderDetail(input.providerId);
      targetId = detail.draft.id;
      const repository = new PlatformAiCatalogRepository(this.db);
      const provider = await repository.getProvider(detail.draft.id);
      if (!provider) throw new AiCatalogNotFoundError();

      const keyVaults = provider.encryptedKeyVaults
        ? await this.secrets.decrypt(provider.encryptedKeyVaults)
        : {};
      const refreshed =
        provider.encryptedKeyVaults && provider.secretFingerprint
          ? await refreshVaultForUpstreamSync({
              ciphertext: provider.encryptedKeyVaults,
              db: this.db,
              fingerprint: provider.secretFingerprint,
              keyVaults,
              providerKey: provider.providerKey,
              providerRowId: provider.id,
              secrets: this.secrets,
            })
          : keyVaults;

      assertSharedAccountConnected(provider, refreshed);

      const normalized = normalizeAiCatalogExecutionCredentials({
        config: provider.config,
        keyVaults: refreshed,
        providerKey: provider.providerKey,
        settings: provider.settings,
        source: provider.source,
      });
      const browserProfile = await resolvePlatformBrowserProfile(
        this.db,
        normalized.runtimeProvider,
      );
      const cards = await enumeratePlatformUpstreamModels({
        browserProfile,
        keyVaults: normalized.keyVaults,
        providerKey: provider.providerKey,
        runtimeProvider: normalized.runtimeProvider,
      });

      const mapped = mapCardsToBatchUpdate(cards, detail.draft.models);
      const { created, items, total, updated } = applyProviderCatalogSyncPolicy(
        provider.providerKey,
        detail.draft.models,
        mapped,
      );

      const appendSyncSuccessAudit = (db: typeof this.db) =>
        new PlatformAuditService(db).append({
          action: 'admin.aiModels.syncUpstream',
          actorUserId,
          afterDiff: { created, total, updated },
          reason,
          result: 'success',
          targetId: detail.draft.id,
          targetType: 'provider',
        });

      if (items.length > 0) {
        await this.runModelApplyTransaction(
          {
            action: 'admin.aiModels.applyImmediate',
            actorUserId,
            auditTargetId: detail.draft.id,
            reason,
            secretTargetId: detail.draft.id,
          },
          async (scoped) => {
            await scoped.applyModelMutation(
              actorUserId,
              {
                expectedDraftToken: detail.draftToken,
                models: items,
                operation: 'batchUpdate',
                providerId: detail.draft.id,
                reason,
              },
              { allowModelCreate: true },
            );
            await scoped.publishAfterMutation(actorUserId, detail.draft.id, reason);
            await appendSyncSuccessAudit(scoped.db);
          },
        );
      } else {
        await appendSyncSuccessAudit(this.db);
      }

      return { created, total, updated };
    } catch (error) {
      await this.appendFailureAudit({
        action: 'admin.aiModels.syncUpstream',
        actorUserId,
        reason,
        targetId,
      });
      throw error;
    }
  };

  private resolveProviderDetail = async (providerId: string) => {
    try {
      return await this.getDetail({ providerKey: providerId });
    } catch (error) {
      if (!(error instanceof AiCatalogNotFoundError)) throw error;
      return this.getDetail(providerId);
    }
  };
}
