import type { ChatModelCard } from '@lobechat/types';
import type { AiModelSettings } from 'model-bank';
import { ModelProvider } from 'model-bank';

import type { OpenAICompatibleFactoryOptions } from '../../core/openaiCompatibleFactory';
import { createOpenAICompatibleRuntime } from '../../core/openaiCompatibleFactory';
import { resolveParameters } from '../../core/parameterResolver';

export interface MistralModelCapabilities {
  audio?: boolean;
  audio_speech?: boolean;
  audio_transcription?: boolean;
  audio_transcription_realtime?: boolean;
  classification?: boolean;
  completion_chat?: boolean;
  completion_fim?: boolean;
  fine_tuning?: boolean;
  function_calling?: boolean;
  moderation?: boolean;
  ocr?: boolean;
  reasoning?: boolean;
  unified_resources?: boolean;
  vision?: boolean;
}

export interface MistralModelCard {
  capabilities: MistralModelCapabilities;
  created?: number;
  description?: string | null;
  id: string;
  max_context_length?: number;
  name?: string | null;
}

// Spec defaults every capability to false, so a missing key is not an assertion.
const mistralAbility = (value?: boolean) => (value === true ? true : undefined);

const mistralTypeFromCapabilities = (
  capabilities?: MistralModelCapabilities,
): ChatModelCard['type'] => {
  if (!capabilities) return undefined;

  const exclusive = [
    capabilities.completion_chat === true && ('chat' as const),
    capabilities.audio_transcription === true && ('asr' as const),
    capabilities.audio_speech === true && ('tts' as const),
  ].filter(Boolean) as Array<'asr' | 'chat' | 'tts'>;

  return exclusive.length === 1 ? exclusive[0] : undefined;
};

const releasedAtFromCreated = (created?: number) =>
  typeof created === 'number' && created > 1_630_000_000
    ? new Date(created * 1000).toISOString().split('T')[0]
    : undefined;

const adjustableReasoningSettings = {
  extendParams: ['enableReasoning'],
} as const satisfies AiModelSettings;

const isAdjustableReasoningModel = (id: string) =>
  ['mistral-medium-3.5', 'mistral-small-latest', 'mistral-small-2603'].includes(id.toLowerCase());

const resolveReasoningEffort = (payload: any) => {
  if (payload.reasoning_effort) return payload.reasoning_effort;

  if (payload.thinking?.type === 'enabled') return 'high';
  if (payload.thinking?.type === 'disabled') return 'none';
};

export const params = {
  baseURL: 'https://api.mistral.ai/v1',
  chatCompletion: {
    // Mistral API does not support stream_options: { include_usage: true }
    // refs: https://github.com/lobehub/lobe-chat/issues/6825
    excludeUsage: true,
    handlePayload: (payload) => {
      // Resolve parameters with normalization
      const resolvedParams = resolveParameters(
        { max_tokens: payload.max_tokens, temperature: payload.temperature, top_p: payload.top_p },
        { normalizeTemperature: true },
      );
      const reasoningEffort = resolveReasoningEffort(payload);

      return {
        ...resolvedParams,
        messages: payload.messages as any,
        model: payload.model,
        ...(reasoningEffort && { reasoning_effort: reasoningEffort }),
        stream: true,
        ...(payload.tools && { tools: payload.tools }),
      };
    },
    noUserId: true,
  },
  debug: {
    chatCompletion: () => process.env.DEBUG_MISTRAL_CHAT_COMPLETION === '1',
  },
  models: async ({ client }) => {
    const { LOBE_DEFAULT_MODEL_LIST } = await import('model-bank');

    const modelsPage = (await client.models.list()) as any;
    const modelList: MistralModelCard[] = modelsPage.data;

    return modelList
      .map((model) => {
        const knownModel = LOBE_DEFAULT_MODEL_LIST.find(
          (m) => model.id.toLowerCase() === m.id.toLowerCase(),
        );

        return {
          contextWindowTokens: model.max_context_length,
          created: model.created,
          description: model.description ?? undefined,
          displayName: knownModel?.displayName ?? model.name ?? undefined,
          enabled: knownModel?.enabled || false,
          functionCall: mistralAbility(model.capabilities?.function_calling),
          id: model.id,
          reasoning:
            mistralAbility(model.capabilities?.reasoning) ?? knownModel?.abilities?.reasoning,
          releasedAt: releasedAtFromCreated(model.created),
          settings:
            knownModel?.settings ??
            (isAdjustableReasoningModel(model.id) ? adjustableReasoningSettings : undefined),
          type: mistralTypeFromCapabilities(model.capabilities),
          vision: mistralAbility(model.capabilities?.vision),
        };
      })
      .filter(Boolean) as ChatModelCard[];
  },
  provider: ModelProvider.Mistral,
} satisfies OpenAICompatibleFactoryOptions;

export const LobeMistralAI = createOpenAICompatibleRuntime(params);
