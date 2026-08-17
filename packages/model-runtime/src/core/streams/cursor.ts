import createDebug from 'debug';

import type { ChatStreamCallbacks } from '../../types';
import { AgentRuntimeErrorType } from '../../types/error';
import { nanoid } from '../../utils/uuid';
import type { StreamContext, StreamProtocolChunk } from './protocol';
import {
  convertIterableToStream,
  createCallbacksTransformer,
  createSSEProtocolTransformer,
  createTokenSpeedCalculator,
} from './protocol';

const log = createDebug('lobe-cursor:stream');

export interface CursorStreamOptions {
  callbacks?: ChatStreamCallbacks;
  inputStartAt?: number;
  model?: string;
  provider?: string;
  streamStack?: StreamContext;
}

interface CursorCliUsage {
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
}

interface CursorCliContentPart {
  text?: string;
  type?: string;
}

interface CursorCliEvent {
  code?: string;
  is_error?: boolean;
  message?: { content?: CursorCliContentPart[] | string; role?: string } | string;
  result?: string;
  subtype?: string;
  text?: string;
  type?: string;
  usage?: CursorCliUsage;
}

const PROVIDER = 'cursor';

/** Keep in sync with `apps/server/src/enterprise/services/cursorAgent/transport.ts`. */
const AUTH_FAILURE_RE =
  /not logged in|unauthori[sz]ed|unauthenticated|\b401\b|authentication|log in|expired token|token expired|invalid token|invalid_api_key/i;

const isRecord = (value: unknown): value is CursorCliEvent =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const parseDataLine = (line: string): unknown | 'done' | undefined => {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return undefined;
  const payload = trimmed.slice('data:'.length).trim();
  if (!payload) return undefined;
  if (payload === '[DONE]') return 'done';
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    log('failed to parse SSE data');
    return undefined;
  }
};

/** ReadableStream → AsyncIterable, without relying on the (non-universal) async iterator. */
export async function* iterateReadable(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array, void, undefined> {
  const reader = stream.getReader();
  let finished = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        return;
      }
      yield value;
    }
  } finally {
    if (!finished) {
      try {
        await reader.cancel();
      } catch {
        // Already cancelled or closed.
      }
    }
    try {
      reader.releaseLock();
    } catch {
      // cancel() already released the lock.
    }
  }
}

async function* iterateCursorSse(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<CursorCliEvent, void, undefined> {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of iterateReadable(stream)) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const parsed = parseDataLine(line);
      if (parsed === 'done') return;
      if (isRecord(parsed)) yield parsed;
    }
  }

  buffer += decoder.decode();
  const parsed = parseDataLine(buffer);
  if (parsed !== 'done' && isRecord(parsed)) yield parsed;
}

const extractAssistantText = (event: CursorCliEvent): string => {
  const message = event.message;
  if (typeof message === 'string') return message;
  const content = message && typeof message === 'object' ? message.content : undefined;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return typeof event.text === 'string' ? event.text : '';
  return content
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('');
};

const eventMessage = (event: CursorCliEvent, fallback: string): string => {
  if (typeof event.message === 'string' && event.message) return event.message;
  if (typeof event.result === 'string' && event.result) return event.result;
  if (typeof event.text === 'string' && event.text) return event.text;
  return fallback;
};

const emitError = (id: string, message: string, errorType: string): StreamProtocolChunk => ({
  data: { message, name: errorType, type: errorType },
  id,
  type: 'error',
});

/**
 * Turn Cursor CLI `stream-json` SSE frames into LobeHub {@link StreamProtocolChunk}s.
 *
 * Consecutive `assistant` events before `result` are treated as text deltas; a
 * final full-text replay (equal to the accumulated deltas, or to `result.result`)
 * is dropped so `--stream-partial-output` does not duplicate the answer.
 */
export async function* transformCursorEvents(
  events: AsyncIterable<CursorCliEvent>,
  options: CursorStreamOptions,
): AsyncGenerator<StreamProtocolChunk, void, undefined> {
  const id = options.streamStack?.id || `chat_${nanoid()}`;
  let assistantText = '';
  let emittedAssistant = false;
  let finished = false;

  const finishSuccess = (event: CursorCliEvent): StreamProtocolChunk[] => {
    const chunks: StreamProtocolChunk[] = [];
    const resultText = typeof event.result === 'string' ? event.result : '';
    if (!emittedAssistant && resultText) {
      chunks.push({ data: resultText, id, type: 'text' });
    } else if (
      emittedAssistant &&
      resultText &&
      resultText.startsWith(assistantText) &&
      resultText.length > assistantText.length
    ) {
      chunks.push({ data: resultText.slice(assistantText.length), id, type: 'text' });
    }

    const inputTokens = event.usage?.inputTokens ?? 0;
    const outputTokens = event.usage?.outputTokens ?? 0;
    chunks.push({
      data: {
        inputCachedTokens: event.usage?.cacheReadTokens,
        totalInputTokens: inputTokens,
        totalOutputTokens: outputTokens,
        totalTokens: inputTokens + outputTokens,
      },
      id,
      type: 'usage',
    });
    chunks.push({ data: 'stop', id, type: 'stop' });
    return chunks;
  };

  for await (const event of events) {
    switch (event.type) {
      case 'thinking': {
        if (event.subtype === 'completed') break;
        const text = typeof event.text === 'string' ? event.text : '';
        if (text) yield { data: text, id, type: 'reasoning' };
        break;
      }

      case 'assistant': {
        const text = extractAssistantText(event);
        if (!text) break;
        // Full replay of already-streamed deltas (or a prefix replay).
        if (emittedAssistant && (text === assistantText || text.startsWith(assistantText))) break;
        assistantText += text;
        emittedAssistant = true;
        yield { data: text, id, type: 'text' };
        break;
      }

      case 'result': {
        finished = true;
        if (event.is_error === true || event.subtype === 'error') {
          const message = eventMessage(event, 'Cursor Agent turn failed');
          const unauthorized = AUTH_FAILURE_RE.test(message);
          yield emitError(
            id,
            message,
            unauthorized
              ? AgentRuntimeErrorType.OAuthAuthorizationExpired
              : AgentRuntimeErrorType.ProviderBizError,
          );
          yield { data: 'stop', id, type: 'stop' };
          break;
        }
        for (const chunk of finishSuccess(event)) yield chunk;
        break;
      }

      case 'transport': {
        if (event.subtype === 'notice') {
          log('%s', eventMessage(event, 'notice'));
          break;
        }
        if (event.subtype === 'error' || event.is_error === true) {
          finished = true;
          const unauthorized = event.code === 'unauthorized';
          yield emitError(
            id,
            eventMessage(event, 'Cursor Agent transport error'),
            unauthorized
              ? AgentRuntimeErrorType.OAuthAuthorizationExpired
              : AgentRuntimeErrorType.ProviderBizError,
          );
          yield { data: 'stop', id, type: 'stop' };
        }
        break;
      }

      case 'system':
      case 'user': {
        break;
      }

      default: {
        break;
      }
    }

    if (finished) return;
  }

  if (!finished) yield { data: 'stop', id, type: 'stop' };
}

export const CursorStream = (
  stream: ReadableStream<Uint8Array>,
  options: CursorStreamOptions = {},
): ReadableStream<Uint8Array> => {
  const streamStack: StreamContext = options.streamStack ?? { id: `chat_${nanoid()}` };
  const chunks = transformCursorEvents(iterateCursorSse(stream), { ...options, streamStack });

  return convertIterableToStream(chunks, {
    model: options.model,
    provider: options.provider ?? PROVIDER,
  })
    .pipeThrough(
      createTokenSpeedCalculator((chunk) => chunk, {
        inputStartAt: options.inputStartAt,
        streamStack,
      }),
    )
    .pipeThrough(createSSEProtocolTransformer((chunk) => chunk, streamStack))
    .pipeThrough(createCallbacksTransformer(options.callbacks, { streamStack }));
};
