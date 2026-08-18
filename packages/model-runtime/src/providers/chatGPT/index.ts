import { BRANDING_NAME } from '@lobechat/business-const';
import { CURRENT_VERSION } from '@lobechat/const';
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

const isCodexModelsEndpointMissing = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false;
  const status =
    (error as { status?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode;
  return typeof status === 'number' && CODEX_MODELS_MISSING_STATUSES.has(status);
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

      return processModelList(modelList, MODEL_LIST_CONFIGS.openai, 'chatgpt');
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
