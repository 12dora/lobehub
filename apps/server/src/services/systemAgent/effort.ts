import type { ModelExtendParams } from '@lobechat/model-runtime';
import { projectServiceModelEffort } from '@lobechat/model-runtime';

/**
 * Look up a model's `settings.extendParams` from provider runtime state.
 *
 * Mirrors the client `aiModelSelectors.modelExtendParams` lookup, plus the
 * aggregator fallback used by `serverCallLlmContextHints`: when the provider
 * card has empty extendParams (e.g. `lobehub` hosting a GPT/Claude id), fall
 * back to the first card with the same model id.
 */
export interface RuntimeStateForEffort {
  enabledAiModels?: Array<{
    id: string;
    providerId: string;
    settings?: { extendParams?: string[] };
  }>;
}

const readExtendParams = (
  model:
    | {
        settings?: { extendParams?: string[] };
      }
    | undefined,
): string[] | undefined => model?.settings?.extendParams;

export function readExtendParamsFromRuntimeState(
  runtimeState: RuntimeStateForEffort | null | undefined,
  model: string,
  provider: string,
): string[] | undefined {
  const models = runtimeState?.enabledAiModels;
  if (!models?.length) return undefined;

  const providerMatch = models.find((item) => item.id === model && item.providerId === provider);
  const fromProvider = readExtendParams(providerMatch);
  if (fromProvider?.length) return fromProvider;

  // Aggregation providers (lobehub) may serve a model without copying origin
  // `settings.extendParams`. Match by id only, skipping empty lists, same as
  // serverCallLlmContextHints falling back to the canonical card.
  const idMatch = models.find((item) => item.id === model && !!readExtendParams(item)?.length);
  return readExtendParams(idMatch);
}

/**
 * Project stored `reasoningEffort` using runtime-state extendParams, falling
 * back to builtin model-bank cards when the user runtime list has no match.
 */
export async function resolveServiceModelEffortParams(params: {
  model: string;
  provider: string;
  reasoningEffort?: string | null;
  runtimeState?: RuntimeStateForEffort | null;
}): Promise<ModelExtendParams> {
  let extendParams = readExtendParamsFromRuntimeState(
    params.runtimeState,
    params.model,
    params.provider,
  );

  if (!extendParams?.length) {
    try {
      const { loadModels } = await import('@/business/client/model-bank/loadModels');
      const builtinModels = await loadModels();
      extendParams = readExtendParamsFromRuntimeState(
        { enabledAiModels: builtinModels },
        params.model,
        params.provider,
      );
    } catch {
      // Builtin catalog is a best-effort fallback; missing it just means `{}`.
    }
  }

  return projectServiceModelEffort({
    extendParams,
    model: params.model,
    reasoningEffort: params.reasoningEffort,
  });
}
