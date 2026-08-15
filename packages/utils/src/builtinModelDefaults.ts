import type {
  AiModelSettings,
  AiModelType,
  ModelAbilities,
  ModelParamsSchema,
  Pricing,
} from 'model-bank';
import { LOBE_DEFAULT_MODEL_LIST } from 'model-bank';

/**
 * The persistable slice of a model-bank card.
 *
 * Single source of truth for "what a builtin model's first platform row looks like", shared by
 * the admin client adapter (which materializes one card when the operator toggles a model that
 * has no row yet) and the server (which materializes a builtin provider's default-enabled cards
 * the moment the provider row is created). Both used to describe the mapping separately, which
 * is how a materialized row could end up with different metadata depending on which path
 * created it.
 *
 * Fields that only make sense at read time (`family`, `generation`, `knowledgeCutoff`,
 * `releasedAt`, `source`, `visible`) are deliberately absent: they are re-derived from the card
 * on every list, and persisting them would freeze a copy that silently goes stale.
 */
export interface BuiltinModelCardPayload {
  abilities?: ModelAbilities;
  /** `0` in a card means "unknown", which the platform column expresses as NULL. */
  contextWindowTokens: number | null;
  description: string | null;
  displayName: string | null;
  parameters?: ModelParamsSchema;
  pricing?: Pricing | null;
  settings?: AiModelSettings;
  type: AiModelType;
}

/** One card payload plus the key it is stored under. */
export interface BuiltinModelDefault extends BuiltinModelCardPayload {
  modelKey: string;
}

type BuiltinCard = (typeof LOBE_DEFAULT_MODEL_LIST)[number];

const normalizeContextWindowTokens = (value: number | null | undefined): number | null =>
  value === 0 ? null : (value ?? null);

const toPayload = (card: BuiltinCard): BuiltinModelCardPayload => ({
  abilities: card.abilities,
  contextWindowTokens: normalizeContextWindowTokens(card.contextWindowTokens),
  description: card.description ?? null,
  displayName: card.displayName ?? null,
  parameters: card.parameters,
  pricing: card.pricing ?? null,
  settings: card.settings,
  // A card with no explicit type is a chat model (same default as the platform column).
  type: card.type ?? 'chat',
});

/**
 * The persistable payload of one builtin model card, or `null` when the provider/model pair is
 * not in model-bank. Callers must treat `null` as "cannot be described" and fail loudly rather
 * than inventing an empty stub row.
 */
export const findBuiltinModelCardPayload = (
  providerId: string,
  modelKey: string,
): BuiltinModelCardPayload | null => {
  const card = LOBE_DEFAULT_MODEL_LIST.find(
    (model) => model.providerId === providerId && model.id === modelKey,
  );
  return card ? toPayload(card) : null;
};

/**
 * Every model a provider's builtin card ships as ON by default, in card order.
 *
 * This is exactly the set the admin model list renders with the toggle already switched on for
 * a provider that has no rows yet, so it is also the set that has to exist as real rows for
 * that display to be true. Covers every model type the card declares (chat AND image) — an
 * image model the card enables is just as visibly "enabled" in the UI as a chat one.
 */
export const listDefaultEnabledBuiltinModels = (providerId: string): BuiltinModelDefault[] =>
  LOBE_DEFAULT_MODEL_LIST.filter((model) => model.providerId === providerId && model.enabled).map(
    (card) => ({ ...toPayload(card), modelKey: card.id }),
  );
