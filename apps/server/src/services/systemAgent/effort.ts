import type { EffortModelCard, ModelExtendParams } from '@lobechat/model-runtime';
import { projectServiceModelEffort, readExtendParamsFromModelCards } from '@lobechat/model-runtime';

/**
 * Look up a model's `settings.extendParams` from provider runtime state.
 *
 * Delegates to the store-agnostic `readExtendParamsFromModelCards` helper so
 * client and server share the aggregator-only fallback rule.
 */
export interface RuntimeStateForEffort {
  enabledAiModels?: EffortModelCard[];
}

export function readExtendParamsFromRuntimeState(
  runtimeState: RuntimeStateForEffort | null | undefined,
  model: string,
  provider: string,
): string[] | undefined {
  return readExtendParamsFromModelCards(runtimeState?.enabledAiModels, model, provider);
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
