import { BRANDING_NAME } from '@lobechat/business-const';
import { CURRENT_VERSION } from '@lobechat/const';
import { isRecord } from '@lobechat/utils/object';
import type { ChatModelCard } from 'model-bank';
import { ModelProvider } from 'model-bank';
import OpenAI from 'openai';

import { createOpenAICompatibleRuntime } from '../../core/openaiCompatibleFactory';
import { MODEL_LIST_CONFIGS, processModelList } from '../../utils/modelParse';
import { params as openAIParams } from '../openai';

const CHATGPT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const CHATGPT_RESPONSES_LITE_HEADER = 'x-openai-internal-codex-responses-lite';
const CHATGPT_RESPONSES_LITE_MODEL_IDS = new Set(['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra']);
const USER_AGENT = `${BRANDING_NAME}/${CURRENT_VERSION}`;

interface ChatGPTClientOptions {
  chatgptAccountId?: string;
}

interface ChatGPTAdditionalToolsInput {
  role: 'developer';
  tools: OpenAI.Responses.Tool[];
  type: 'additional_tools';
}

const isResponsesLiteModel = (model: string | undefined) =>
  !!model && CHATGPT_RESPONSES_LITE_MODEL_IDS.has(model);

/** Codex `/models` is undocumented — only "this route is not there" is a catalog fallback. */
const CODEX_MODELS_MISSING_STATUSES = new Set([404, 405, 501]);

/**
 * Catalog sync reads this after `processModelList` has already turned every
 * capability into a boolean. Empty object = live payload sent none of them.
 */
export const UPSTREAM_REPORTED_ABILITIES = 'upstreamReportedAbilities';

const UPSTREAM_ABILITY_KEYS = [
  'files',
  'functionCall',
  'imageOutput',
  'reasoning',
  'search',
  'video',
  'vision',
] as const;

const AUTH_ERROR_TYPE = /authentication|authorization|permission/i;
const AUTH_ERROR_CODE =
  /invalid[_-]?(?:token|api[_-]?key)|unauthorized|forbidden|token[_-]?expired|access[_-]?denied/i;

const collectErrorSignals = (value: unknown, into: string[]): void => {
  if (!isRecord(value)) return;
  if (typeof value.code === 'string') into.push(value.code);
  if (typeof value.type === 'string') into.push(value.type);
  if ('error' in value) collectErrorSignals(value.error, into);
  if ('body' in value) collectErrorSignals(value.body, into);
};

/** A 404/405/501 is "route missing" only when the payload does not say otherwise. */
const isCodexModelsEndpointMissing = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false;
  const status =
    (error as { status?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode;
  if (typeof status !== 'number' || !CODEX_MODELS_MISSING_STATUSES.has(status)) return false;
  const signals: string[] = [];
  collectErrorSignals(error, signals);
  return !signals.some((signal) => AUTH_ERROR_TYPE.test(signal) || AUTH_ERROR_CODE.test(signal));
};

const attachUpstreamAbilityProvenance = (
  cards: ChatModelCard[],
  rawModels: unknown[],
): ChatModelCard[] => {
  const reportedById = new Map<string, Record<string, boolean>>();
  for (const raw of rawModels) {
    if (!isRecord(raw) || typeof raw.id !== 'string') continue;
    const reported: Record<string, boolean> = {};
    for (const key of UPSTREAM_ABILITY_KEYS) {
      const value = raw[key];
      if (typeof value === 'boolean') reported[key] = value;
    }
    reportedById.set(raw.id, reported);
  }
  return cards.map((card) => {
    const reported = reportedById.get(card.id);
    if (!reported) return card;
    return { ...card, [UPSTREAM_REPORTED_ABILITIES]: reported };
  });
};

export const LobeChatGPTAI = createOpenAICompatibleRuntime<ChatGPTClientOptions>({
  baseURL: CHATGPT_CODEX_BASE_URL,
  chatCompletion: {
    useResponse: true,
  },
  customClient: {
    createClient: ({ chatgptAccountId, ...options }) =>
      new OpenAI({
        ...options,
        defaultHeaders: {
          ...options.defaultHeaders,
          ...(chatgptAccountId && { 'ChatGPT-Account-Id': chatgptAccountId }),
          'User-Agent': USER_AGENT,
          'originator': 'lobehub',
          'session-id': crypto.randomUUID(),
          'version': CURRENT_VERSION,
        },
      }),
  },
  debug: {
    chatCompletion: () => process.env.DEBUG_CHATGPT_CHAT_COMPLETION === '1',
    responses: () => process.env.DEBUG_CHATGPT_RESPONSES === '1',
  },
  // Codex `/models` is undocumented and may simply not exist. Auth, rate-limit,
  // and transport failures must surface — those are the errors an operator can act on.
  models: async ({ client }) => {
    try {
      const modelsPage = (await client.models.list()) as { data?: unknown };
      const modelList = modelsPage.data;
      if (!Array.isArray(modelList)) {
        throw new TypeError('ChatGPT Codex models payload was not a list');
      }

      return attachUpstreamAbilityProvenance(
        await processModelList(modelList, MODEL_LIST_CONFIGS.openai, 'chatgpt'),
        modelList,
      );
    } catch (error) {
      if (!(error instanceof TypeError) && !isCodexModelsEndpointMissing(error)) {
        throw error;
      }

      const { chatgpt } = await import('model-bank');

      return processModelList(chatgpt, MODEL_LIST_CONFIGS.openai, 'chatgpt');
    }
  },
  provider: ModelProvider.ChatGPT,
  responses: {
    handlePayload: (payload) => {
      const handledPayload = openAIParams.responses?.handlePayload?.(payload) || payload;
      const { service_tier: _serviceTier, ...rest } = handledPayload;

      // The ChatGPT Codex backend manages output limits from the subscription
      // model catalog and rejects the public API's max_output_tokens field.
      return {
        ...rest,
        include: ['reasoning.encrypted_content'],
        max_tokens: undefined,
      };
    },
    prepareRequest: (payload) => {
      const { safety_identifier: _safetyIdentifier, ...subscriptionPayload } = payload;

      if (!isResponsesLiteModel(payload.model)) {
        return { payload: subscriptionPayload };
      }

      // Codex GPT-5.6 models use Responses Lite: tools move into the input
      // sequence, reasoning spans all turns, and the protocol header is required.
      const {
        input,
        instructions,
        parallel_tool_calls: _parallelToolCalls,
        reasoning,
        tool_choice: toolChoice,
        tools,
        ...rest
      } = subscriptionPayload;
      const additionalTools: ChatGPTAdditionalToolsInput = {
        role: 'developer',
        tools: tools || [],
        type: 'additional_tools',
      };
      const developerInstructions =
        instructions && typeof instructions === 'string'
          ? [
              {
                content: [{ text: instructions, type: 'input_text' as const }],
                role: 'developer' as const,
                type: 'message' as const,
              },
            ]
          : [];

      return {
        headers: { [CHATGPT_RESPONSES_LITE_HEADER]: 'true' },
        payload: {
          ...rest,
          input: [
            additionalTools as OpenAI.Responses.ResponseInputItem,
            ...developerInstructions,
            ...(Array.isArray(input) ? input : []),
          ],
          parallel_tool_calls: false,
          reasoning: { ...reasoning, context: 'all_turns' },
          tool_choice: toolChoice || 'auto',
        },
      };
    },
  },
});
