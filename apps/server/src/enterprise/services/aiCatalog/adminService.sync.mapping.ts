import type { ChatModelCard } from 'model-bank';
import { applyChatGPTWebModelPolicy } from 'model-bank';

import type { AdminAiModelApplyImmediateInput, AiProviderDraft } from '../../contracts/aiCatalog';
import { mergeModelUpdateFields } from './modelBatchDml';

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

const CHATGPTWEB_PROVIDER = 'chatgptweb';

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

const optionalPositiveInt = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;

const optionalModelType = (value: unknown): string | undefined =>
  typeof value === 'string' && MODEL_TYPES.has(value) ? value : undefined;

const optionalSettingsRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const cardToBatchUpdateItem = (card: ChatModelCard, id: string): BatchUpdateItem => {
  const abilities = collectAbilities(card);
  const displayName = clip(card.displayName, DISPLAY_NAME_MAX);
  const description = clip(card.description, DESCRIPTION_MAX);
  const contextWindowTokens = optionalPositiveInt(card.contextWindowTokens);
  const type = optionalModelType(card.type);
  const settings = optionalSettingsRecord(card.settings);
  return {
    id,
    ...(abilities !== undefined ? { abilities } : {}),
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(displayName !== undefined ? { displayName } : {}),
    ...(settings ? { settings } : {}),
    ...(type ? { type } : {}),
  };
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
    const item = cardToBatchUpdateItem(card, current?.id ?? modelKey);

    if (!current) {
      // applyImmediate publishes site-wide — new remotes stay off until an admin enables them.
      items.push({ ...item, enabled: false, type: item.type ?? 'chat' });
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

const readSettingsRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};

type MappedCards = ReturnType<typeof mapCardsToBatchUpdate>;

/**
 * One-shot chatgptweb catalog cleanup after the family-card revert.
 *
 * Live cards already carry the right `extendParams` from `models()`. This pass
 * walks every existing chatgptweb row (including SKUs the live list omitted)
 * and rewrites settings through `applyChatGPTWebModelPolicy`, which deletes
 * leftover `legacyAlias` stamps and normalises thinking / pro / none. Idempotent:
 * rows whose settings already match are skipped.
 */
export const applyChatGPTWebCatalogSyncPolicy = (
  existing: readonly DraftModel[],
  mapped: MappedCards,
): MappedCards => {
  const itemsById = new Map(mapped.items.map((item) => [item.id, { ...item }]));
  let { updated } = mapped;

  for (const row of existing) {
    const current = itemsById.get(row.id);
    const baseSettings = readSettingsRecord(current?.settings ?? row.settings);
    const policy = applyChatGPTWebModelPolicy({
      abilities: row.abilities,
      modelId: row.modelKey,
      providerId: CHATGPTWEB_PROVIDER,
      settings: baseSettings,
    });
    const nextSettings = (policy.settings ?? {}) as Record<string, unknown>;
    if (stableJson(baseSettings) === stableJson(nextSettings)) continue;

    const candidate: BatchUpdateItem = {
      ...(current ?? { id: row.id }),
      id: row.id,
      settings: nextSettings,
    };
    if (!current) updated += 1;
    itemsById.set(row.id, candidate);
  }

  return { created: mapped.created, items: [...itemsById.values()], total: mapped.total, updated };
};

export const applyProviderCatalogSyncPolicy = (
  providerKey: string,
  existing: readonly DraftModel[],
  mapped: MappedCards,
): MappedCards =>
  providerKey === CHATGPTWEB_PROVIDER ? applyChatGPTWebCatalogSyncPolicy(existing, mapped) : mapped;
