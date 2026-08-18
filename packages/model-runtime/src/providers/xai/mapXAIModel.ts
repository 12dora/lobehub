import type { Pricing } from 'model-bank';

/**
 * Documented `GET /v1/models` card. Fields with no ChatModelCard destination
 * (`aliases`, `owned_by`, `object`, `prompt_image_token_price`) and the
 * unit-ambiguous `image_price` are typed so we do not invent mappings for them.
 *
 * @see https://docs.x.ai/developers/rest-api-reference/inference/models
 */
export interface XAIModelCard {
  aliases?: string[];
  cached_prompt_text_token_price?: number | null;
  cached_prompt_text_token_price_long_context?: number | null;
  completion_text_token_price?: number | null;
  completion_text_token_price_long_context?: number | null;
  context_length?: number | null;
  created?: number;
  id: string;
  image_price?: number | null;
  long_context_threshold?: number | null;
  object?: string;
  owned_by?: string;
  prompt_image_token_price?: number | null;
  prompt_text_token_price?: number | null;
  prompt_text_token_price_long_context?: number | null;
}

/**
 * xAI documents token prices as USD cents per 100 million tokens.
 * USD per million = (cents / 100) × (1e6 / 1e8) = value / 10_000.
 * Cross-check against published Grok 4.3 rates (docs.x.ai/developers/pricing):
 *   12500 → $1.25, 2000 → $0.20, 25000 → $2.50.
 */
const xaiCentsPer100MToUsdPerMillion = (centsPer100M: number) => centsPer100M / 10_000;

const xaiTokenPrice = (centsPer100M: number | null | undefined): number | undefined =>
  typeof centsPer100M === 'number' ? xaiCentsPer100MToUsdPerMillion(centsPer100M) : undefined;

// A documented 0 long-context price means "fall back to the standard rate".
const xaiLongContextRate = (
  longCentsPer100M: number | null | undefined,
  standardUsdPerMillion: number | undefined,
): number | undefined => {
  if (typeof longCentsPer100M === 'number' && longCentsPer100M > 0) {
    return xaiCentsPer100MToUsdPerMillion(longCentsPer100M);
  }
  return standardUsdPerMillion;
};

const pushTieredUnit = (
  units: Pricing['units'],
  name: 'textInput' | 'textInput_cacheRead' | 'textOutput',
  standard: number | undefined,
  longRate: number | undefined,
  threshold: number,
) => {
  if (typeof standard !== 'number' || typeof longRate !== 'number') return;

  // xAI applies long-context rates at or above the threshold. computeChatCost
  // matches a tier with `quantity <= upTo`, so the standard band must end at
  // threshold - 1 or the exact-threshold request is undercharged 2×.
  units.push({
    name,
    strategy: 'tiered',
    tiers: [
      { rate: standard, upTo: threshold - 1 },
      { rate: longRate, upTo: 'infinity' },
    ],
    unit: 'millionTokens',
  });
};

type XAIMappedPricing = {
  cachedInput?: number;
  input?: number;
  output?: number;
  units?: Pricing['units'];
};

const mapXAIPricing = (model: XAIModelCard): XAIMappedPricing | undefined => {
  const input = xaiTokenPrice(model.prompt_text_token_price);
  const output = xaiTokenPrice(model.completion_text_token_price);
  const cachedInput = xaiTokenPrice(model.cached_prompt_text_token_price);
  const threshold = model.long_context_threshold;

  if (typeof threshold === 'number' && threshold > 0) {
    const units: Pricing['units'] = [];
    pushTieredUnit(
      units,
      'textInput',
      input,
      xaiLongContextRate(model.prompt_text_token_price_long_context, input),
      threshold,
    );
    pushTieredUnit(
      units,
      'textOutput',
      output,
      xaiLongContextRate(model.completion_text_token_price_long_context, output),
      threshold,
    );
    pushTieredUnit(
      units,
      'textInput_cacheRead',
      cachedInput,
      xaiLongContextRate(model.cached_prompt_text_token_price_long_context, cachedInput),
      threshold,
    );
    return units.length > 0 ? { units } : undefined;
  }

  if (input === undefined && output === undefined && cachedInput === undefined) {
    return undefined;
  }

  return { cachedInput, input, output };
};

export const mapXAIModel = (model: XAIModelCard) => ({
  contextWindowTokens: typeof model.context_length === 'number' ? model.context_length : undefined,
  created: model.created,
  id: model.id,
  pricing: mapXAIPricing(model),
});
