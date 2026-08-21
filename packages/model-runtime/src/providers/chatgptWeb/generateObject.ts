import type {
  ChatMethodOptions,
  ChatStreamPayload,
  GenerateObjectOptions,
  GenerateObjectPayload,
  OnFinishData,
  OpenAIChatMessage,
} from '../../types';
import { AgentRuntimeErrorType } from '../../types/error';
import { consumeStreamUntilDone } from '../../utils/consumeStream';
import { AgentRuntimeError } from '../../utils/createError';
import { isCallerAbort } from './client';

const JSON_ONLY_INSTRUCTION =
  'Answer ONLY with a JSON object that matches the JSON Schema below. No markdown, no code fences, no commentary.';

export const buildChatGPTWebGenerateObjectMessages = (
  payload: GenerateObjectPayload,
): OpenAIChatMessage[] => {
  const instruction = [
    JSON_ONLY_INSTRUCTION,
    payload.schema ? `JSON Schema:\n${JSON.stringify(payload.schema.schema)}` : undefined,
  ]
    .filter(Boolean)
    .join('\n\n');

  return [{ content: instruction, role: 'system' }, ...payload.messages];
};

/**
 * Strip a wrapping markdown fence and parse. Throws {@link SyntaxError} when
 * the remaining text is not JSON.
 */
export const parseJsonFromModelText = (text: string): unknown => {
  const trimmed = text.trim();
  if (!trimmed) throw new SyntaxError('empty structured output');

  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through and strip a wrapping markdown fence.
  }

  let candidate = trimmed;
  if (candidate.startsWith('```')) {
    candidate = candidate.slice(3);
    if (candidate.slice(0, 4).toLowerCase() === 'json') candidate = candidate.slice(4);
    if (candidate.startsWith('\n')) candidate = candidate.slice(1);
    const close = candidate.lastIndexOf('```');
    if (close !== -1) candidate = candidate.slice(0, close);
    candidate = candidate.trim();
  }

  return JSON.parse(candidate);
};

export const runChatGPTWebGenerateObject = async (params: {
  chat: (payload: ChatStreamPayload, options?: ChatMethodOptions) => Promise<Response>;
  options?: GenerateObjectOptions;
  payload: GenerateObjectPayload;
  provider: string;
}): Promise<unknown> => {
  const { chat, options, payload, provider } = params;
  if (!payload.schema) {
    throw AgentRuntimeError.chat({
      error: { message: 'schema is required' },
      errorType: AgentRuntimeErrorType.InvalidRequestFormat,
      provider,
    });
  }

  let finish: OnFinishData | undefined;
  const response = await chat(
    {
      chatgptWebReasoningEffort: payload.chatgptWebReasoningEffort,
      messages: buildChatGPTWebGenerateObjectMessages(payload),
      model: payload.model,
      reasoning_effort: payload.reasoning_effort,
    },
    {
      callback: {
        onCompletion: (data) => {
          finish = data;
        },
      },
      headers: options?.headers,
      signal: options?.signal,
    },
  );

  await consumeStreamUntilDone(response);

  if (isCallerAbort(options?.signal)) {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    throw error;
  }

  try {
    return parseJsonFromModelText(finish?.text ?? '');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw AgentRuntimeError.chat({
      error: { message },
      errorType: AgentRuntimeErrorType.UpstreamMalformedResponse,
      message,
      provider,
    });
  }
};
