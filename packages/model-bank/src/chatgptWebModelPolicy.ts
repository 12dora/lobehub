import { ModelProvider } from './const/modelProvider';
import type { AiModelSettings, ExtendParamsType } from './types/aiModel';

/** ChatGPT.com GPT-5.x family card ids (`gpt-5-6`, `gpt-5-5`, …). */
export const CHATGPT_WEB_FAMILY_BASE_RE = /^gpt-5-\d+$/;

/** Instant / thinking / Pro SKUs that collapse into a family card. */
export const CHATGPT_WEB_FAMILY_SKU_RE = /^(gpt-5-\d+)-(instant|thinking|pro)$/;

/** Family id stamped onto leftover `auto` rows. */
export const CHATGPT_WEB_DEFAULT_FAMILY = 'gpt-5-6';

const CHATGPT_WEB_EFFORT_EXTEND_PARAMS = new Set<string>([
  'chatgptWebReasoningEffort',
  'gpt5_6ReasoningEffort',
]);

const FAMILY_EXTEND_PARAMS = ['chatgptWebReasoningEffort'] as const satisfies ExtendParamsType[];

export const isChatGPTWebProviderId = (providerId: string): boolean =>
  providerId.toLowerCase() === ModelProvider.ChatGPTWeb;

export const isChatGPTWebFamilyModelId = (modelId: string): boolean =>
  CHATGPT_WEB_FAMILY_BASE_RE.test(modelId);

export const isChatGPTWebLegacyPickerId = (modelId: string): boolean =>
  modelId === 'auto' || CHATGPT_WEB_FAMILY_SKU_RE.test(modelId);

const isChatGPTWebPassthroughNoEffortId = (modelId: string): boolean =>
  modelId === 'o3' || modelId.endsWith('-mini');

export const chatgptWebFamilyAliasFor = (modelId: string): string => {
  const match = modelId.match(CHATGPT_WEB_FAMILY_SKU_RE);
  return match?.[1] ?? CHATGPT_WEB_DEFAULT_FAMILY;
};

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
  visible?: false;
}

/**
 * Read-time / sync-time ChatGPT Web effort + picker policy.
 *
 * Family ids expose exactly `chatgptWebReasoningEffort` (never the OpenAI
 * Platform `gpt5_6ReasoningEffort` key). Instant / thinking / Pro / `auto` /
 * o3 / minis never advertise those keys. Legacy picker SKUs also stamp
 * `legacyAlias` so callers can hide them without disabling the allowlist.
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

  if (isChatGPTWebFamilyModelId(modelId)) {
    delete next.legacyAlias;
    next.extendParams = [...FAMILY_EXTEND_PARAMS];
    return { settings: next as AiModelSettings };
  }

  if (isChatGPTWebLegacyPickerId(modelId)) {
    const extendParams = stripEffortExtendParams(next.extendParams);
    if (extendParams) next.extendParams = extendParams;
    else delete next.extendParams;
    next.legacyAlias = chatgptWebFamilyAliasFor(modelId);
    return { settings: next as AiModelSettings, visible: false };
  }

  if (isChatGPTWebPassthroughNoEffortId(modelId)) {
    const extendParams = stripEffortExtendParams(next.extendParams);
    if (extendParams) next.extendParams = extendParams;
    else delete next.extendParams;
    return { settings: toSettings(next) };
  }

  return { settings: toSettings(next) ?? (settings as AiModelSettings | undefined) };
};
