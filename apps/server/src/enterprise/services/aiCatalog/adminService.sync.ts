import type { ChatModelCard } from 'model-bank';
import { isProviderOAuthDeviceFlow } from 'model-bank/modelProviders';

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
  AiCatalogValidationError,
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

const CHATGPTWEB_PROVIDER = 'chatgptweb';
const CHATGPT_WEB_FAMILY_BASE_RE = /^gpt-5-\d+$/;
const CHATGPT_WEB_LEGACY_SKU_RE = /^(gpt-5-\d+)-(instant|thinking|pro)$/;
const CHATGPT_WEB_DEFAULT_FAMILY = 'gpt-5-6';
const CHATGPT_WEB_LEGACY_ALIAS_KEY = 'legacyAlias';

export const isChatGPTWebLegacyPickerId = (modelKey: string): boolean =>
  modelKey === 'auto' || CHATGPT_WEB_LEGACY_SKU_RE.test(modelKey);

const familyAliasForLegacyKey = (modelKey: string): string => {
  const match = modelKey.match(CHATGPT_WEB_LEGACY_SKU_RE);
  return match?.[1] ?? CHATGPT_WEB_DEFAULT_FAMILY;
};

const readSettingsRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};

/**
 * Existing providers keep a persisted `checkModel` from first connect. After the
 * family-card cutover that is often `auto` (or an Instant/Thinking/Pro SKU),
 * which then fails the connectivity probe with "Check model not enabled".
 */
export const resolveChatGPTWebCheckModelUpgrade = (
  current: string | null | undefined,
  existing: readonly DraftModel[],
  cards: ChatModelCard[],
): string | undefined => {
  if (!current || !isChatGPTWebLegacyPickerId(current)) return undefined;

  const enabledKeys = new Set(
    existing.filter((model) => model.enabled).map((model) => model.modelKey),
  );
  if (enabledKeys.has(CHATGPT_WEB_DEFAULT_FAMILY)) return CHATGPT_WEB_DEFAULT_FAMILY;

  const enabledFamily = existing.find(
    (model) => model.enabled && CHATGPT_WEB_FAMILY_BASE_RE.test(model.modelKey),
  );
  if (enabledFamily) return enabledFamily.modelKey;

  const familyCard =
    cards.find((card) => card.id === CHATGPT_WEB_DEFAULT_FAMILY) ??
    cards.find((card) => CHATGPT_WEB_FAMILY_BASE_RE.test(card.id));
  return familyCard?.id ?? CHATGPT_WEB_DEFAULT_FAMILY;
};

const abilitiesFromCardFlags = (card: ChatModelCard): Record<string, boolean> | undefined => {
  const abilities: Record<string, boolean> = {};
  let reported = false;
  for (const key of ABILITY_KEYS) {
    const value = card[key];
    if (typeof value !== 'boolean') continue;
    reported = true;
    if (value) abilities[key] = true;
  }
  return reported ? abilities : undefined;
};

type MappedCards = ReturnType<typeof mapCardsToBatchUpdate>;

/**
 * When chatgptweb `models()` collapses Instant / Thinking / Pro SKUs into one
 * family card, existing catalog rows for those SKUs (and `auto`) stay **enabled**
 * so the execution allowlist still admits saved agents, but they are marked
 * `settings.legacyAlias` so user-facing pickers hide them. Matching is against
 * existing rows (`/^gpt-5-\d+-(instant|thinking|pro)$/` plus `auto`), not the
 * live family-card set — a gpt-5-5 SKU or a lone `auto` still reconciles when
 * the current enumeration has no matching family.
 *
 * Do **not** set `enabled: false`: that both drops the row from the allowlist
 * (`AiCatalogModelNotPublishedError` on the next turn) and trips the published
 * agent/setting dependency check (`AiCatalogResourceInUseError`), aborting sync.
 */
export const reconcileChatGPTWebLegacySkus = (
  cards: ChatModelCard[],
  existing: readonly DraftModel[],
  mapped: MappedCards,
): MappedCards => {
  const familyCards = cards.filter((card) => CHATGPT_WEB_FAMILY_BASE_RE.test(card.id));
  const itemsById = new Map(mapped.items.map((item) => [item.id, { ...item }]));
  let { updated } = mapped;
  const existingByKey = new Map(existing.map((model) => [model.modelKey, model]));

  for (const card of familyCards) {
    const row = existingByKey.get(card.id);
    if (!row) continue;

    const abilities = abilitiesFromCardFlags(card);
    const current = itemsById.get(row.id);
    const candidate: BatchUpdateItem = {
      ...(current ?? { id: row.id }),
      ...(abilities ? { abilities } : {}),
      id: row.id,
    };
    if (!metadataChanged(row, candidate)) continue;
    if (!current) updated += 1;
    itemsById.set(row.id, candidate);
  }

  for (const row of existing) {
    if (!isChatGPTWebLegacyPickerId(row.modelKey)) continue;
    const alias = familyAliasForLegacyKey(row.modelKey);
    const current = itemsById.get(row.id);
    const baseSettings = readSettingsRecord(current?.settings ?? row.settings);
    if (baseSettings[CHATGPT_WEB_LEGACY_ALIAS_KEY] === alias && row.enabled !== false) continue;

    const candidate: BatchUpdateItem = {
      ...(current ?? { id: row.id }),
      id: row.id,
      settings: { ...baseSettings, [CHATGPT_WEB_LEGACY_ALIAS_KEY]: alias },
      ...(row.enabled === false ? { enabled: true } : {}),
    };
    if (!current) updated += 1;
    itemsById.set(row.id, candidate);
  }

  return { created: mapped.created, items: [...itemsById.values()], total: mapped.total, updated };
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
      const { created, items, total, updated } =
        provider.providerKey === CHATGPTWEB_PROVIDER
          ? reconcileChatGPTWebLegacySkus(cards, detail.draft.models, mapped)
          : mapped;
      const checkModelUpgrade =
        provider.providerKey === CHATGPTWEB_PROVIDER
          ? resolveChatGPTWebCheckModelUpgrade(provider.checkModel, detail.draft.models, cards)
          : undefined;

      const appendSyncSuccessAudit = (db: typeof this.db, extra?: { checkModel?: string }) =>
        new PlatformAuditService(db).append({
          action: 'admin.aiModels.syncUpstream',
          actorUserId,
          afterDiff: { created, total, updated, ...extra },
          reason,
          result: 'success',
          targetId: detail.draft.id,
          targetType: 'provider',
        });

      if (items.length > 0 || checkModelUpgrade) {
        await this.runModelApplyTransaction(
          {
            action: 'admin.aiModels.applyImmediate',
            actorUserId,
            auditTargetId: detail.draft.id,
            reason,
            secretTargetId: detail.draft.id,
          },
          async (scoped) => {
            if (items.length > 0) {
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
            }
            if (checkModelUpgrade) {
              const repository = new PlatformAiCatalogRepository(scoped.db);
              await repository.updateProvider(detail.draft.id, {
                checkModel: checkModelUpgrade,
                status: 'draft',
                updatedBy: actorUserId,
              });
            }
            await scoped.publishAfterMutation(actorUserId, detail.draft.id, reason);
            await appendSyncSuccessAudit(
              scoped.db,
              checkModelUpgrade ? { checkModel: checkModelUpgrade } : undefined,
            );
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
