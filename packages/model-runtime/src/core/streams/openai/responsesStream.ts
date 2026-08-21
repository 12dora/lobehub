import type { ChatCitationItem, ChatMessageError } from '@lobechat/types';
import type OpenAI from 'openai';
import type { Stream } from 'openai/streaming';

import { AgentRuntimeErrorType } from '../../../types/error';
import { serializeScopedSignature } from '../../../utils/signatureScope';
import { convertOpenAIResponseUsage } from '../../usageConverters';
import type {
  ChatPayloadForTransformStream,
  StreamContext,
  StreamProtocolChunk,
  StreamProtocolToolCallChunk,
  StreamToolCallChunkData,
} from '../protocol';
import {
  convertIterableToStream,
  createCallbacksTransformer,
  createFirstErrorHandleTransformer,
  createSSEProtocolTransformer,
  createTokenSpeedCalculator,
  FIRST_CHUNK_ERROR_KEY,
} from '../protocol';
import type { OpenAIStreamOptions } from './openai';

/**
 * Map Responses `incomplete_details.reason` onto the chat-completions finish
 * vocabulary (`length` for max tokens; other reasons pass through).
 */
const mapResponsesIncompleteFinishReason = (reason?: string | null): string => {
  if (reason === 'max_output_tokens') return 'length';
  return reason || 'incomplete';
};

const emitResponsesTerminalChunks = (
  chunk: {
    response: {
      id: string;
      incomplete_details?: { reason?: string } | null;
      status?: string | null;
      usage?: OpenAI.Responses.ResponseUsage | null;
    };
    type: string;
  },
  streamContext: StreamContext,
  payload: ChatPayloadForTransformStream | undefined,
  finishReason: string,
): StreamProtocolChunk[] => {
  const chunks: StreamProtocolChunk[] = [];
  const responseId = chunk.response.id;

  if (chunk.response.usage) {
    delete streamContext.usageMissingDiagnostics;
    chunks.push({
      data: convertOpenAIResponseUsage(chunk.response.usage, payload),
      id: responseId,
      type: 'usage',
    });
  } else {
    streamContext.usageMissingDiagnostics = {
      apiMode: 'responses',
      hasUsageMetadata: false,
      includeUsageRequested: payload?.includeUsageRequested,
      model: payload?.model,
      provider: payload?.provider,
      responseId,
      source: 'openai_responses',
      terminalEventType: chunk.type,
      terminalStatus: chunk.response.status ?? undefined,
    };

    chunks.push({ data: chunk, id: streamContext.id, type: 'data' });
  }

  chunks.push({ data: finishReason, id: responseId, type: 'stop' });
  return chunks;
};

const transformOpenAIStream = (
  chunk:
    | OpenAI.Responses.ResponseStreamEvent
    | {
        annotation: {
          end_index: number;
          start_index: number;
          title: string;
          type: 'url_citation';
          url: string;
        };
        item_id: string;
        type: 'response.output_text.annotation.added';
      },
  streamContext: StreamContext,
  payload?: ChatPayloadForTransformStream,
): StreamProtocolChunk | StreamProtocolChunk[] => {
  // handle the first chunk error
  if (FIRST_CHUNK_ERROR_KEY in chunk) {
    delete chunk[FIRST_CHUNK_ERROR_KEY];
    // @ts-ignore
    delete chunk['name'];
    // @ts-ignore
    delete chunk['stack'];

    const errorData = {
      body: chunk,
      message:
        'message' in chunk
          ? typeof chunk.message === 'string'
            ? chunk.message
            : JSON.stringify(chunk)
          : JSON.stringify(chunk),
      type:
        'errorType' in chunk
          ? (chunk.errorType as typeof AgentRuntimeErrorType.ProviderBizError)
          : AgentRuntimeErrorType.ProviderBizError,
    } satisfies ChatMessageError;
    return { data: errorData, id: 'first_chunk_error', type: 'error' };
  }

  try {
    switch (chunk.type) {
      case 'response.created': {
        streamContext.id = chunk.response.id;
        streamContext.returnedCitationArray = [];

        return { data: chunk.response.status, id: streamContext.id, type: 'data' };
      }

      case 'response.output_item.added': {
        switch (chunk.item.type) {
          case 'function_call': {
            streamContext.hasFunctionCall = true;
            streamContext.toolIndex =
              typeof streamContext.toolIndex === 'undefined' ? 0 : streamContext.toolIndex + 1;
            streamContext.tool = {
              id: chunk.item.call_id,
              index: streamContext.toolIndex,
              name: chunk.item.name,
            };

            return {
              data: [
                {
                  function: { arguments: chunk.item.arguments, name: chunk.item.name },
                  id: chunk.item.call_id,
                  index: streamContext.toolIndex!,
                  type: 'function',
                } satisfies StreamToolCallChunkData,
              ],
              id: streamContext.id,
              type: 'tool_calls',
            } satisfies StreamProtocolToolCallChunk;
          }
        }

        return { data: chunk.item, id: streamContext.id, type: 'data' };
      }

      case 'response.function_call_arguments.delta': {
        return {
          data: [
            {
              function: { arguments: chunk.delta, name: streamContext.tool?.name },
              id: streamContext.tool?.id,
              index: streamContext.toolIndex!,
              type: 'function',
            } satisfies StreamToolCallChunkData,
          ],
          id: streamContext.id,
          type: 'tool_calls',
        } satisfies StreamProtocolToolCallChunk;
      }
      case 'response.output_text.delta': {
        streamContext.outputTextDeltaItemIds ??= new Set();
        streamContext.outputTextDeltaItemIds.add(chunk.item_id);

        return { data: chunk.delta, id: chunk.item_id, type: 'text' };
      }

      case 'response.output_text.done': {
        // Deltas already streamed the answer; repeating the full string here
        // would duplicate content. Only backfill when the provider skipped deltas.
        if (streamContext.outputTextDeltaItemIds?.has(chunk.item_id)) {
          return { data: chunk, id: streamContext.id, type: 'data' };
        }

        const text = 'text' in chunk && typeof chunk.text === 'string' ? chunk.text : '';
        if (!text) return { data: chunk, id: streamContext.id, type: 'data' };

        return { data: text, id: chunk.item_id, type: 'text' };
      }

      case 'response.reasoning_text.delta': {
        if (chunk.delta) streamContext.reasoningHasContent = true;

        return { data: chunk.delta, id: chunk.item_id, type: 'reasoning' };
      }

      case 'response.reasoning_summary_part.added': {
        // Do not emit an empty reasoning("") on the first part — that starts
        // the Thinking indicator before any content exists. Keep `\n` only as
        // a separator between parts that already streamed content.
        if (streamContext.reasoningHasContent) {
          streamContext.reasoningHasContent = false;
          return { data: '\n', id: chunk.item_id, type: 'reasoning' };
        }

        return { data: chunk, id: streamContext.id, type: 'data' };
      }

      case 'response.reasoning_summary_text.delta': {
        if (chunk.delta) streamContext.reasoningHasContent = true;

        return { data: chunk.delta, id: chunk.item_id, type: 'reasoning' };
      }

      case 'response.output_text.annotation.added': {
        // OpenAI SDK v6 types the annotation payload as `unknown`; narrow to the URL-citation shape we read.
        const citations = chunk.annotation as { title?: string; url?: string };

        if (streamContext.returnedCitationArray) {
          streamContext.returnedCitationArray.push({
            title: citations.title,
            url: citations.url,
          } as ChatCitationItem);
        }

        return { data: null, id: chunk.item_id, type: 'text' };
      }

      case 'response.output_item.done': {
        if (chunk.item.type === 'reasoning') {
          const scopedEncryptedContent = chunk.item.encrypted_content
            ? serializeScopedSignature(
                chunk.item.encrypted_content,
                payload?.reasoningSignatureScope,
                'reasoning',
              )
            : undefined;
          const hasSummaryText = chunk.item.summary?.some(({ text }) => !!text);

          // Without a trustworthy channel scope, persistence and replay are both
          // disabled, including summary-only response items. Visible reasoning
          // deltas still stream through their dedicated events. Do not emit
          // `text: null` — fetchSSE drops it, and a text event would also
          // incorrectly end (or start) the client thinking indicator.
          if (!payload?.reasoningSignatureScope || (!scopedEncryptedContent && !hasSummaryText))
            return {
              data: { id: chunk.item.id, type: chunk.item.type },
              id: chunk.item.id,
              type: 'data',
            };

          const chunks: StreamProtocolChunk[] = [
            {
              data: {
                ...chunk.item,
                encrypted_content: scopedEncryptedContent,
              },
              id: chunk.item.id,
              type: 'reasoning_response_item',
            },
          ];

          /**
           * Dual-emit the scope-serialized payload on the legacy string-only event so
           * already-released clients keep single-item reasoning continuation. New clients
           * prefer `responseItems` on replay, so the redundancy is harmless.
           */
          if (scopedEncryptedContent)
            chunks.push({
              data: scopedEncryptedContent,
              id: chunk.item.id,
              type: 'reasoning_signature',
            });

          return chunks;
        }

        if (streamContext.returnedCitationArray?.length) {
          return {
            data: { citations: streamContext.returnedCitationArray },
            id: chunk.item.id,
            type: 'grounding',
          };
        }

        return { data: null, id: chunk.item.id, type: 'text' };
      }

      case 'response.incomplete': {
        // Terminal: OpenAI/Azure hit a limit (max_output_tokens, content_filter)
        // and emit this instead of `response.completed`. Without `stop`, the
        // partial answer is treated as a successful stream with no usage and
        // no finish reason.
        return emitResponsesTerminalChunks(
          chunk,
          streamContext,
          payload,
          mapResponsesIncompleteFinishReason(chunk.response.incomplete_details?.reason),
        );
      }

      case 'response.completed': {
        // Always close the protocol stream. Without `stop`, the client thinking
        // indicator stays on when no later text/tool event arrives (Grok).
        // Plain completions map to `stop` so the executor's answer-in-thinking
        // salvage (`finishReason === 'stop'`) still fires. Function-call turns
        // use `tool_calls` so salvage does not promote thinking into the answer.
        const finishReason = streamContext.hasFunctionCall
          ? 'tool_calls'
          : chunk.response.status === 'completed'
            ? 'stop'
            : (chunk.response.status ?? 'stop');

        return emitResponsesTerminalChunks(chunk, streamContext, payload, finishReason);
      }

      default: {
        return { data: chunk, id: streamContext.id, type: 'data' };
      }
    }
  } catch (e) {
    const errorName = 'StreamChunkError';
    console.error(`[${errorName}]`, e);
    console.error(`[${errorName}] raw chunk:`, chunk);

    const err = e as Error;

    const errorData = {
      body: {
        message:
          'chat response streaming chunk parse error, please contact your API Provider to fix it.',
        context: { error: { message: err.message, name: err.name }, chunk },
      },
      type: errorName,
    } as ChatMessageError;

    return { data: errorData, id: streamContext.id, type: 'error' };
  }
};

export const OpenAIResponsesStream = (
  stream: Stream<OpenAI.Responses.ResponseStreamEvent> | ReadableStream,
  {
    callbacks,
    bizErrorTypeTransformer,
    inputStartAt,
    enableStreaming = true,
    payload,
  }: OpenAIStreamOptions = {},
) => {
  const streamStack: StreamContext = { id: '' };

  const readableStream =
    stream instanceof ReadableStream
      ? stream
      : convertIterableToStream(stream, { model: payload?.model, provider: payload?.provider });

  // use closure to pass payload to transformOpenAIStream
  const transformWithPayload: typeof transformOpenAIStream = (chunk, streamContext) =>
    transformOpenAIStream(chunk, streamContext, payload);

  return (
    readableStream
      // 1. handle the first error if exist
      // provider like huggingface or minimax will return error in the stream,
      // so in the first Transformer, we need to handle the error
      .pipeThrough(createFirstErrorHandleTransformer(bizErrorTypeTransformer, payload?.provider))
      .pipeThrough(
        createTokenSpeedCalculator(transformWithPayload, {
          enableStreaming,
          inputStartAt,
          streamStack,
        }),
      )
      .pipeThrough(createSSEProtocolTransformer((c) => c, streamStack))
      .pipeThrough(createCallbacksTransformer(callbacks, { streamStack }))
  );
};
