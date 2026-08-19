import type { ContentModerationConfig } from '@/types/platform/contentModeration';

import type { EvaluatePromptInput, SkippedDecision } from './decisionService';
import { hashPrompt } from './normalize';
import { isExempt, isModelInScope, isSampled } from './policy';

export const maybeSkipEvaluation = (
  config: ContentModerationConfig,
  input: EvaluatePromptInput,
  roles: readonly string[],
): SkippedDecision | null => {
  if (config.mode === 'off') return { reason: 'mode_off', skipped: true };

  if (isExempt({ config, roles, userId: input.userId })) {
    return { reason: 'exempt', skipped: true };
  }
  if (!config.requestKinds.includes(input.requestKind)) {
    return { reason: 'request_kind', skipped: true };
  }
  if (!isModelInScope({ config, model: input.model, provider: input.provider })) {
    return { reason: 'model_scope', skipped: true };
  }

  const hash = hashPrompt(input.text);
  if (!isSampled(hash, config.scope.sampleRate)) {
    return { reason: 'not_sampled', skipped: true };
  }

  return null;
};
