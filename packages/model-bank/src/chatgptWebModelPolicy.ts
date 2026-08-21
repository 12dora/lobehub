import { ModelProvider } from './const/modelProvider';
import type { AiModelSettings, ExtendParamsType } from './types/aiModel';

const CHATGPT_WEB_EFFORT_EXTEND_PARAMS = new Set<string>([
  'chatgptWebProThinkingEffort',
  'chatgptWebReasoningEffort',
  'chatgptWebThinkingEffort',
  'gpt5_6ReasoningEffort',
]);

const THINKING_EXTEND_PARAMS = ['chatgptWebThinkingEffort'] as const satisfies ExtendParamsType[];
const PRO_EXTEND_PARAMS = ['chatgptWebProThinkingEffort'] as const satisfies ExtendParamsType[];

export const isChatGPTWebProviderId = (providerId: string): boolean =>
  providerId.toLowerCase() === ModelProvider.ChatGPTWeb;

const isThinkingSku = (modelId: string): boolean => modelId.endsWith('-thinking');
const isProSku = (modelId: string): boolean => modelId.endsWith('-pro');

const readSettingsRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};

const stripEffortExtendParams = (extendParams: unknown): ExtendParamsType[] | undefined => {
  if (!Array.isArray(extendParams)) return undefined;
  const kept = extendParams.filter(
    (param): param is ExtendParamsType =>
      typeof param === 'string' && !CHATGPT_WEB_EFFORT_EXTEND_PARAMS.has(param),
  );
  return kept.length > 0 ? kept : undefined;
};

const withEffortKey = (
  next: Record<string, unknown>,
  key: (typeof THINKING_EXTEND_PARAMS)[number] | (typeof PRO_EXTEND_PARAMS)[number],
): AiModelSettings => {
  const kept = stripEffortExtendParams(next.extendParams) ?? [];
  next.extendParams = [...kept, key];
  return next as AiModelSettings;
};

const toSettings = (record: Record<string, unknown>): AiModelSettings | undefined =>
  Object.keys(record).length > 0 ? (record as AiModelSettings) : undefined;

export interface ApplyChatGPTWebModelPolicyInput {
  abilities?: unknown;
  modelId: string;
  providerId: string;
  settings?: unknown;
}

export interface ChatGPTWebModelPolicy {
  settings: AiModelSettings | undefined;
}

/**
 * Read-time / sync-time ChatGPT Web effort policy.
 *
 * `*-thinking` SKUs expose `chatgptWebThinkingEffort`; `*-pro` SKUs expose
 * `chatgptWebProThinkingEffort`; every other slug has neither. Leftover
 * `legacyAlias` stamps from the earlier family-card sync are deleted so every
 * SKU is visible again. Custom-source rows are skipped by callers.
 *
 * `abilities` is part of the contract so callers pass the live row; effort is
 * decided by id, not by `abilities.reasoning` (o3 reasons but has no slider).
 */
export const applyChatGPTWebModelPolicy = ({
  modelId,
  providerId,
  settings,
}: ApplyChatGPTWebModelPolicyInput): ChatGPTWebModelPolicy => {
  if (!isChatGPTWebProviderId(providerId)) {
    return { settings: settings as AiModelSettings | undefined };
  }

  const next = readSettingsRecord(settings);
  delete next.legacyAlias;

  if (isThinkingSku(modelId)) {
    return { settings: withEffortKey(next, THINKING_EXTEND_PARAMS[0]) };
  }

  if (isProSku(modelId)) {
    return { settings: withEffortKey(next, PRO_EXTEND_PARAMS[0]) };
  }

  const extendParams = stripEffortExtendParams(next.extendParams);
  if (extendParams) next.extendParams = extendParams;
  else delete next.extendParams;
  return { settings: toSettings(next) };
};
