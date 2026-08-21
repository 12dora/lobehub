import { normalizeThinkingEffort } from './requestBuilders';
import type { ThinkingEffort } from './types';

export interface ChatGPTWebTurn {
  model: string;
  thinkingEffort?: ThinkingEffort;
}

/**
 * Resolve chatgpt.com `thinking_effort` for one turn. The wire model is always
 * the selected slug — no family remapping at send time.
 *
 * Verified against real Chrome captures 2026-08-21: chatgpt.com accepts
 * `thinking_effort` ∈ standard | extended | max only.
 *
 * - `*-thinking`: send the chosen value (omit when unset). legacy low/medium/high/xhigh aliases still map via {@link normalizeThinkingEffort}.
 * - `*-pro`: always `standard` (leftover values are ignored).
 * - every other slug (`auto`, bare `gpt-5-6`, `-instant`, minis, `o3`): never
 *   send `thinking_effort`.
 */
export const resolveChatGPTWebTurn = ({
  model,
  thinkingEffort,
}: {
  model: string;
  thinkingEffort?: string | null;
}): ChatGPTWebTurn => {
  if (model.endsWith('-pro')) {
    return { model, thinkingEffort: 'standard' };
  }

  if (model.endsWith('-thinking')) {
    const effort = normalizeThinkingEffort(thinkingEffort);
    return effort ? { model, thinkingEffort: effort } : { model };
  }

  return { model };
};
