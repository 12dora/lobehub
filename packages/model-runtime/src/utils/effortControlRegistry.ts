import type { LobeAgentChatConfig } from '@lobechat/types';
import type { ExtendParamsType } from 'model-bank';

/**
 * Superset of every discrete "thinking effort" level any model family exposes.
 * Individual controls only accept the subset listed in their registry entry.
 */
export type EffortLevel =
  | 'no_think'
  | 'disabled'
  | 'none'
  | 'minimal'
  | 'auto'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'enabled';

export interface EffortControlDefinition {
  /** The LobeAgentChatConfig field the chosen level is written to. */
  configKey: keyof LobeAgentChatConfig;
  /** Static default when the user never picked a level (model-specific overrides may apply). */
  defaultLevel: EffortLevel;
  /** Ordered levels, weakest → strongest. */
  levels: readonly EffortLevel[];
}

/**
 * Single source of truth for every discrete-level "thinking effort" extend param:
 * which chatConfig field it writes, which levels it offers, and its default.
 *
 * Keys intentionally exclude boolean switches (`enableReasoning`, `preserveThinking`,
 * `enableAdaptiveThinking`), token budgets (`reasoningBudgetToken*`, `thinkingBudget`)
 * and non-effort modes (`reasoningMode`, verbosity/image params).
 *
 * The per-key level lists must stay in sync with the sliders under
 * `src/features/ModelSwitchPanel/components/ControlsForm/` — those sliders import
 * their levels from here.
 *
 * Model-specific default overrides that this static table cannot express:
 * - `gpt5_2ReasoningEffort` defaults to `medium` for `gpt-5.5` (see ControlsForm).
 * - `thinkingLevel*` defaults come from `resolveDefaultThinkingLevelForModel`.
 */
export const EFFORT_CONTROL_REGISTRY = {
  codexMaxReasoningEffort: {
    configKey: 'codexMaxReasoningEffort',
    defaultLevel: 'medium',
    levels: ['low', 'medium', 'high', 'xhigh'],
  },
  deepseekV4ReasoningEffort: {
    configKey: 'deepseekV4ReasoningEffort',
    defaultLevel: 'high',
    levels: ['none', 'high', 'max'],
  },
  effort: {
    configKey: 'effort',
    defaultLevel: 'high',
    levels: ['low', 'medium', 'high', 'max'],
  },
  glm5_2ReasoningEffort: {
    configKey: 'glm5_2ReasoningEffort',
    defaultLevel: 'max',
    levels: ['high', 'max'],
  },
  gpt5ReasoningEffort: {
    configKey: 'gpt5ReasoningEffort',
    defaultLevel: 'medium',
    levels: ['minimal', 'low', 'medium', 'high'],
  },
  gpt5_1ReasoningEffort: {
    configKey: 'gpt5_1ReasoningEffort',
    defaultLevel: 'none',
    levels: ['none', 'low', 'medium', 'high'],
  },
  gpt5_2ProReasoningEffort: {
    configKey: 'gpt5_2ProReasoningEffort',
    defaultLevel: 'medium',
    levels: ['medium', 'high', 'xhigh'],
  },
  gpt5_2ReasoningEffort: {
    configKey: 'gpt5_2ReasoningEffort',
    defaultLevel: 'none',
    levels: ['none', 'low', 'medium', 'high', 'xhigh'],
  },
  gpt5_6ReasoningEffort: {
    configKey: 'gpt5_6ReasoningEffort',
    defaultLevel: 'medium',
    levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  },
  grok4_20ReasoningEffort: {
    configKey: 'grok4_20ReasoningEffort',
    defaultLevel: 'medium',
    levels: ['low', 'medium', 'high', 'xhigh'],
  },
  grok4_3ReasoningEffort: {
    configKey: 'grok4_3ReasoningEffort',
    defaultLevel: 'low',
    levels: ['none', 'low', 'medium', 'high'],
  },
  grok4_5ReasoningEffort: {
    configKey: 'grok4_5ReasoningEffort',
    defaultLevel: 'high',
    levels: ['low', 'medium', 'high'],
  },
  hy3ReasoningEffort: {
    configKey: 'hy3ReasoningEffort',
    defaultLevel: 'high',
    levels: ['no_think', 'low', 'high'],
  },
  kimiK3ReasoningEffort: {
    configKey: 'kimiK3ReasoningEffort',
    defaultLevel: 'max',
    levels: ['low', 'high', 'max'],
  },
  opus47Effort: {
    configKey: 'opus47Effort',
    defaultLevel: 'high',
    levels: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  reasoningEffort: {
    configKey: 'reasoningEffort',
    defaultLevel: 'medium',
    levels: ['low', 'medium', 'high'],
  },
  ring2_6ReasoningEffort: {
    configKey: 'ring2_6ReasoningEffort',
    defaultLevel: 'high',
    levels: ['high', 'xhigh'],
  },
  step3_5ReasoningEffort: {
    configKey: 'step3_5ReasoningEffort',
    defaultLevel: 'low',
    levels: ['low', 'high'],
  },
  thinkingLevel: {
    configKey: 'thinkingLevel',
    defaultLevel: 'high',
    levels: ['minimal', 'low', 'medium', 'high'],
  },
  thinkingLevel2: {
    configKey: 'thinkingLevel2',
    defaultLevel: 'high',
    levels: ['low', 'high'],
  },
  thinkingLevel3: {
    configKey: 'thinkingLevel3',
    defaultLevel: 'high',
    levels: ['low', 'medium', 'high'],
  },
  thinkingLevel4: {
    configKey: 'thinkingLevel4',
    defaultLevel: 'minimal',
    levels: ['minimal', 'high'],
  },
  // Kept last on purpose: `thinking` (OFF / Auto / ON) is closer to a mode than a
  // strength, so models that also expose a real effort key resolve to that key first.
  thinking: {
    configKey: 'thinking',
    defaultLevel: 'auto',
    levels: ['disabled', 'auto', 'enabled'],
  },
} as const satisfies Partial<Record<ExtendParamsType, EffortControlDefinition>>;

export type EffortControlKey = keyof typeof EFFORT_CONTROL_REGISTRY;

export const EFFORT_CONTROL_KEYS = Object.keys(EFFORT_CONTROL_REGISTRY) as EffortControlKey[];

export const isEffortControlKey = (key: string): key is EffortControlKey =>
  Object.hasOwn(EFFORT_CONTROL_REGISTRY, key);

/**
 * Pick the effort control for a model from its `settings.extendParams`.
 * Registry declaration order is the priority order (real effort keys win over
 * the tri-state `thinking` toggle).
 */
export const findEffortControl = (
  extendParams: readonly string[] | undefined,
): { definition: EffortControlDefinition; key: EffortControlKey } | undefined => {
  if (!extendParams || extendParams.length === 0) return undefined;
  const present = new Set(extendParams);
  for (const key of EFFORT_CONTROL_KEYS) {
    if (present.has(key)) return { definition: EFFORT_CONTROL_REGISTRY[key], key };
  }
  return undefined;
};

/**
 * Clamp a persisted level onto what the control actually offers; returns the
 * control default when the stored level is not offered (e.g. model changed).
 */
export const clampEffortLevel = (
  definition: EffortControlDefinition,
  level: string | undefined,
): EffortLevel =>
  level && (definition.levels as readonly string[]).includes(level)
    ? (level as EffortLevel)
    : definition.defaultLevel;
