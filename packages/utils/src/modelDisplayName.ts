import { LOBE_DEFAULT_MODEL_LIST } from 'model-bank';
import { DEFAULT_MODEL_PROVIDER_LIST } from 'model-bank/modelProviders';

/**
 * Human-readable labels for the raw `model` / `provider` identifiers that usage, statistics and
 * audit rows store.
 *
 * Those columns keep the wire ids (`auto`, `gpt-5.6-luna`, `chatgptweb`) because that is what the
 * runtime sent; rendering them verbatim is what makes an admin read "auto" and have no idea which
 * model answered. The model-bank card already carries the name a human recognizes, so the display
 * layer resolves the id through it instead of inventing a formatting rule. In particular we never
 * append a provider suffix ourselves — a card that needs disambiguation (every ChatGPT Web card)
 * already spells it out in its own `displayName`.
 *
 * Pure and synchronous: no React, no i18n. Provider names that have a localized copy are
 * translated by the caller (see `@/utils/modelLabels`), which falls back to these values.
 */

interface ModelNameIndex {
  /** `id` → first card's display name, for rows whose provider is unknown or third-party. */
  byId: Map<string, string>;
  /** `providerId` + `PAIR_SEPARATOR` + `id` → display name. */
  byPair: Map<string, string>;
}

let modelNameIndex: ModelNameIndex | undefined;

/**
 * NUL, written as an escape so this file stays plain-text source. Model ids contain `/`, `.`, `:`
 * and `-`, so any printable separator is a character some id could also carry, which would let two
 * different pairs share one key; NUL appears in no provider or model id.
 */
const PAIR_SEPARATOR = '\u0000';

const pairKey = (providerId: string, modelId: string) => `${providerId}${PAIR_SEPARATOR}${modelId}`;

/**
 * Built on first use and kept forever: `LOBE_DEFAULT_MODEL_LIST` is a static array of thousands of
 * cards, so scanning it per table cell would be the expensive part of rendering a usage table.
 */
const getModelNameIndex = (): ModelNameIndex => {
  if (!modelNameIndex) {
    const byId = new Map<string, string>();
    const byPair = new Map<string, string>();

    for (const card of LOBE_DEFAULT_MODEL_LIST) {
      // A card with no displayName has nothing better to offer than the raw id, so leaving it out
      // keeps "found" meaning "found a name".
      if (!card.displayName) continue;
      byPair.set(pairKey(card.providerId, card.id), card.displayName);
      if (!byId.has(card.id)) byId.set(card.id, card.displayName);
    }

    modelNameIndex = { byId, byPair };
  }

  return modelNameIndex;
};

let providerNameIndex: Map<string, string> | undefined;

const getProviderNameIndex = (): Map<string, string> => {
  if (!providerNameIndex) {
    providerNameIndex = new Map(
      DEFAULT_MODEL_PROVIDER_LIST.map((provider) => [provider.id, provider.name]),
    );
  }

  return providerNameIndex;
};

/**
 * The name a human recognizes for one model id, or the id itself when model-bank does not describe
 * it (self-hosted, third-party gateway, a model added after this build).
 *
 * `providerId` narrows the lookup so the same id under two providers resolves to that provider's
 * own card; without it — or when the pair is unknown, which is the case for every heterogeneous
 * agent row, whose provider is `codex` / `claude-code` rather than the model's vendor — the first
 * card carrying the id wins, which still yields the right product name.
 *
 * Aggregate sentinels (`__other__`) and empty values pass through untouched: they are not models,
 * and the caller decides how to label them.
 */
export const getModelDisplayName = (
  modelId: string | null | undefined,
  providerId?: string | null,
): string => {
  if (!modelId) return '';

  const { byId, byPair } = getModelNameIndex();

  if (providerId) {
    const exact = byPair.get(pairKey(providerId, modelId));
    if (exact) return exact;
  }

  return byId.get(modelId) ?? modelId;
};

/** The builtin provider card's name, or `undefined` when the id is not a builtin provider. */
export const findBuiltinProviderName = (
  providerId: string | null | undefined,
): string | undefined => (providerId ? getProviderNameIndex().get(providerId) : undefined);

/**
 * The name a human recognizes for one provider id, or the id itself when it is not a builtin
 * provider.
 *
 * Heterogeneous agent providers (`codex`, `claude-code`, …) have no model-bank card; UI layers
 * resolve those through `@/utils/modelLabels`, which layers their labels on top of this.
 */
export const getProviderDisplayName = (providerId: string | null | undefined): string => {
  if (!providerId) return '';

  return findBuiltinProviderName(providerId) ?? providerId;
};
