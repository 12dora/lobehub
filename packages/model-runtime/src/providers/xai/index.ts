import { isRecord } from '@lobechat/utils';
import { ModelProvider } from 'model-bank';

import { createOpenAICompatibleRuntime } from '../../core/openaiCompatibleFactory';
import type { ChatCompletionTool, ChatResponseFormat, ChatStreamPayload } from '../../types';
import { MODEL_LIST_CONFIGS, processModelList } from '../../utils/modelParse';
import { createXAIImage } from './createImage';
import { createXAIVideo } from './createVideo';
import type { XAIModelCard } from './mapXAIModel';
import { mapXAIModel } from './mapXAIModel';

export type { XAIModelCard } from './mapXAIModel';

interface XAIChatStreamPayload extends ChatStreamPayload {
  frequencyPenalty?: number;
  presencePenalty?: number;
  stop?: string | string[];
}

const supportsChatCompletionPenaltyParameters = (model: string) => model.startsWith('grok-3');

const stripUnsupportedPenaltyParameters = (payload: ChatStreamPayload) => {
  const {
    frequencyPenalty: _frequencyPenalty,
    presencePenalty: _presencePenalty,
    ...rest
  } = payload as XAIChatStreamPayload;

  return {
    ...rest,
    frequency_penalty: undefined,
    presence_penalty: undefined,
    stop: undefined,
  } as ChatStreamPayload;
};

const pruneUnsupportedChatCompletionParameters = (payload: ChatStreamPayload) => {
  if (supportsChatCompletionPenaltyParameters(payload.model)) return payload;

  return stripUnsupportedPenaltyParameters(payload);
};

const hasSlashDelimitedEnumValue = (value: unknown) =>
  Array.isArray(value) && value.some((item) => typeof item === 'string' && item.includes('/'));

/**
 * xAI Responses rejects some otherwise valid JSON Schema constraints in function tools.
 * Keep the tool usable by removing only slash-delimited enum constraints, such as MIME
 * values (`text/plain`) from Gmail MCP schemas.
 */
const sanitizeXAIToolSchema = (schema: unknown): unknown => {
  if (Array.isArray(schema)) return schema.map((item) => sanitizeXAIToolSchema(item));

  if (!isRecord(schema)) return schema;

  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(schema)) {
    if (key === 'enum' && hasSlashDelimitedEnumValue(value)) continue;

    sanitized[key] = sanitizeXAIToolSchema(value);
  }

  return sanitized;
};

const sanitizeXAITools = (tools?: ChatCompletionTool[]) =>
  tools?.map((tool) => {
    if (!tool.function.parameters) return tool;

    return {
      ...tool,
      function: {
        ...tool.function,
        parameters: sanitizeXAIToolSchema(
          tool.function.parameters,
        ) as ChatCompletionTool['function']['parameters'],
      },
    };
  });

const XAI_NATIVE_SEARCH_TOOL_TYPES = new Set(['web_search', 'x_search']);

const isXAIFunctionTool = (tool: unknown): tool is ChatCompletionTool =>
  isRecord(tool) && tool.type === 'function' && isRecord(tool.function);

const isXAINativeSearchTool = (tool: unknown): tool is { type: string } =>
  isRecord(tool) && typeof tool.type === 'string' && XAI_NATIVE_SEARCH_TOOL_TYPES.has(tool.type);

/**
 * Sanitize function tools only. Native xAI server tools (`web_search` / `x_search`)
 * have no `.function` schema and must not go through `sanitizeXAITools`.
 */
const withXAINativeSearchTools = (tools: unknown[] | undefined, enabledSearch?: boolean) => {
  const incoming = tools ?? [];
  const sanitizedFunctionTools = sanitizeXAITools(incoming.filter(isXAIFunctionTool)) ?? [];
  const nativeTools = enabledSearch
    ? [
        ...incoming
          .filter(isXAINativeSearchTool)
          .filter(
            (tool, index, list) => list.findIndex((item) => item.type === tool.type) === index,
          ),
        ...[{ type: 'web_search' }, { type: 'x_search' }].filter(
          (tool) =>
            !incoming.some((item) => isXAINativeSearchTool(item) && item.type === tool.type),
        ),
      ]
    : [];

  if (sanitizedFunctionTools.length === 0 && nativeTools.length === 0) return undefined;

  return [...sanitizedFunctionTools, ...nativeTools];
};

/**
 * xAI Responses API accepts structured output constraints under `text.format`,
 * while callers still send OpenAI Chat Completions compatible `response_format`.
 */
const mapResponseFormatToResponsesText = (
  responseFormat?: ChatResponseFormat,
  text?: ChatStreamPayload['text'],
) => {
  if (!responseFormat) return text;

  if (responseFormat.type === 'json_schema') {
    return {
      ...text,
      format: { type: 'json_schema', ...responseFormat.json_schema },
    };
  }

  return {
    ...text,
    format: { type: responseFormat.type },
  };
};

/**
 * Payload handlers shared with the `supergrok` provider, which talks to the
 * same api.x.ai endpoint (authenticated via OAuth instead of an API key).
 */
export const handleXAIChatCompletionPayload = (payload: ChatStreamPayload) =>
  ({
    ...pruneUnsupportedChatCompletionParameters(payload),
    apiMode: 'responses',
    stream: payload.stream ?? true,
  }) as any;

export const handleXAIResponsesPayload = (payload: ChatStreamPayload) => {
  const { enabledSearch, response_format, text, tools, ...rest } =
    stripUnsupportedPenaltyParameters(payload);

  return {
    ...rest,
    tools: withXAINativeSearchTools(tools as unknown[] | undefined, enabledSearch),
    text: mapResponseFormatToResponsesText(response_format, text),
    include: ['reasoning.encrypted_content'],
  } as any;
};

export const LobeXAI = createOpenAICompatibleRuntime({
  baseURL: 'https://api.x.ai/v1',
  chatCompletion: {
    handlePayload: handleXAIChatCompletionPayload,
    useResponse: true,
  },
  createImage: createXAIImage,
  createVideo: createXAIVideo,
  handlePollVideoStatus: async (inferenceId, options) => {
    const { pollXAIVideoStatus } = await import('./createVideo');
    return pollXAIVideoStatus(inferenceId, {
      apiKey: options.apiKey,
      baseURL: options.baseURL || '',
    });
  },
  debug: {
    chatCompletion: () => process.env.DEBUG_XAI_CHAT_COMPLETION === '1',
    responses: () => process.env.DEBUG_XAI_RESPONSES === '1',
  },
  models: async ({ client }) => {
    const modelsPage = (await client.models.list()) as { data?: XAIModelCard[] };
    const modelList: XAIModelCard[] = modelsPage.data ?? [];

    return processModelList(modelList.map(mapXAIModel), MODEL_LIST_CONFIGS.xai, 'xai');
  },
  promptCacheKeyModels: [/^grok-/],
  provider: ModelProvider.XAI,
  responses: {
    handlePayload: handleXAIResponsesPayload,
  },
});
