import type { ChatModelCard } from 'model-bank';

import { PlatformAiCatalogRepository } from '@/database/repositories/platformAiCatalog';
import type { LobeChatDatabase } from '@/database/type';
import {
  buildPayloadFromKeyVaults,
  initModelRuntimeWithUserPayload,
  resolvePlatformBrowserProfile,
} from '@/server/modules/ModelRuntime';

import type { AdminAiModelApplyImmediateInput, AiProviderDraft } from '../../contracts/aiCatalog';
import { PlatformAuditService } from '../platformAudit';
import { AiCatalogAdminServiceModelOps } from './adminService.models';
import { aiConnectionFailureCode, classifyAiConnectionFailure } from './connectionTestService';
import { normalizeAiCatalogExecutionCredentials } from './credentialAdapter';
import {
  AiCatalogCannotEnumerateError,
  AiCatalogNotFoundError,
  AiCatalogUpstreamSyncError,
} from './errors';
import { mergeModelUpdateFields } from './modelBatchDml';
import type { AiCatalogSecretManager } from './secretManager';
import {
  isOAuthAuthorizationExpiredError,
  isSharedOAuthRefreshConsumedError,
  refreshSharedOAuthVault,
} from './sharedOAuthRefresh';

const SYNC_UPSTREAM_REASON = 'Sync models from upstream';
const MODEL_KEY_MAX = 150;
const DISPLAY_NAME_MAX = 200;
const DESCRIPTION_MAX = 4000;
const MODEL_TYPES = new Set([
  'asr',
  'chat',
  'embedding',
  'image',
  'realtime',
  'text2music',
  'tts',
  'video',
]);
const ABILITY_KEYS = [
  'files',
  'functionCall',
  'imageOutput',
  'reasoning',
  'search',
  'video',
  'vision',
] as const;

type BatchUpdateItem = Extract<
  AdminAiModelApplyImmediateInput,
  { operation: 'batchUpdate' }
>['models'][number];

type DraftModel = AiProviderDraft['models'][number];

const clip = (value: string | undefined, max: number): string | undefined => {
  if (value == null) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
};

/**
 * Field ChatGPT (and any other hook that can still see the raw payload) stamps
 * after `processModelList`. That function materializes every capability as a
 * boolean, so without this the mapper cannot tell "upstream said false" from
 * "upstream said nothing".
 */
const UPSTREAM_REPORTED_ABILITIES = 'upstreamReportedAbilities';

const readUpstreamReportedAbilities = (
  card: ChatModelCard,
): Partial<Record<(typeof ABILITY_KEYS)[number], boolean>> | undefined => {
  const value = (card as unknown as Record<string, unknown>)[UPSTREAM_REPORTED_ABILITIES];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Partial<Record<(typeof ABILITY_KEYS)[number], boolean>>;
};

/**
 * Clear an ability only when the provider hook recorded that upstream actually
 * sent `false`. Cards that only went through `processModelList` have no
 * provenance — treat them as silent and leave stored abilities alone.
 */
const collectAbilities = (card: ChatModelCard): Record<string, boolean> | undefined => {
  const provenance = readUpstreamReportedAbilities(card);
  if (!provenance) return undefined;

  const abilities: Record<string, boolean> = {};
  let reported = false;
  for (const key of ABILITY_KEYS) {
    const value = provenance[key];
    if (typeof value !== 'boolean') continue;
    reported = true;
    if (value) abilities[key] = true;
  }
  return reported ? abilities : undefined;
};

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

const stableJson = (value: unknown): string => {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
};

const metadataChanged = (current: DraftModel, patch: BatchUpdateItem): boolean => {
  const merged = mergeModelUpdateFields(current as Parameters<typeof mergeModelUpdateFields>[0], {
    abilities: patch.abilities,
    config: patch.config,
    contextWindowTokens: patch.contextWindowTokens,
    description: patch.description,
    displayName: patch.displayName,
    parameters: patch.parameters,
    pricing: patch.pricing,
    settings: patch.settings,
    type: patch.type,
  });
  return (
    stableJson(current.abilities) !== stableJson(merged.abilities) ||
    current.contextWindowTokens !== merged.contextWindowTokens ||
    current.description !== merged.description ||
    current.displayName !== merged.displayName ||
    stableJson(current.settings) !== stableJson(merged.settings) ||
    current.type !== merged.type
  );
};

export const mapCardsToBatchUpdate = (
  cards: ChatModelCard[],
  existing: readonly DraftModel[],
): { created: number; items: BatchUpdateItem[]; total: number; updated: number } => {
  const existingByKey = new Map(existing.map((model) => [model.modelKey, model]));
  const seen = new Set<string>();
  const items: BatchUpdateItem[] = [];
  let created = 0;
  let updated = 0;
  let total = 0;

  for (const card of cards) {
    const modelKey = clip(card.id, MODEL_KEY_MAX);
    if (!modelKey || seen.has(modelKey)) continue;
    seen.add(modelKey);
    total += 1;

    const current = existingByKey.get(modelKey);
    const abilities = collectAbilities(card);
    const displayName = clip(card.displayName, DISPLAY_NAME_MAX);
    const description = clip(card.description, DESCRIPTION_MAX);
    const contextWindowTokens =
      typeof card.contextWindowTokens === 'number' &&
      Number.isInteger(card.contextWindowTokens) &&
      card.contextWindowTokens > 0
        ? card.contextWindowTokens
        : undefined;
    const type =
      typeof card.type === 'string' && MODEL_TYPES.has(card.type) ? card.type : undefined;
    const settings =
      card.settings && typeof card.settings === 'object' && !Array.isArray(card.settings)
        ? (card.settings as Record<string, unknown>)
        : undefined;

    const item: BatchUpdateItem = {
      id: current?.id ?? modelKey,
      ...(abilities !== undefined ? { abilities } : {}),
      ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(displayName !== undefined ? { displayName } : {}),
      ...(settings ? { settings } : {}),
      ...(type ? { type } : {}),
    };

    if (!current) {
      // applyImmediate publishes site-wide — new remotes stay off until an admin enables them.
      items.push({ ...item, enabled: false, type: type ?? 'chat' });
      created += 1;
      continue;
    }

    if (metadataChanged(current, item)) {
      items.push(item);
      updated += 1;
    }
  }

  return { created, items, total, updated };
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
      let refreshed = keyVaults;
      if (provider.encryptedKeyVaults && provider.secretFingerprint) {
        try {
          refreshed = await refreshSharedOAuthVault({
            ciphertext: provider.encryptedKeyVaults,
            db: this.db,
            fingerprint: provider.secretFingerprint,
            keyVaults,
            providerKey: provider.providerKey,
            providerRowId: provider.id,
            secrets: this.secrets,
          });
        } catch (error) {
          if (isOAuthAuthorizationExpiredError(error) || isSharedOAuthRefreshConsumedError(error)) {
            throw toUpstreamSyncError(error);
          }
          // Token-endpoint blip before the rotating token is spent — the still-valid
          // access token may list models. Persist failures after exchange are terminal.
          refreshed = keyVaults;
        }
      }

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

      const { created, items, total, updated } = mapCardsToBatchUpdate(cards, detail.draft.models);

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
