import type { ChatCitationItem } from '@lobechat/types';
import createDebug from 'debug';

import {
  CURSOR_TOOL_CALLS_CLOSE,
  CURSOR_TOOL_CALLS_OPEN,
} from '../../providers/cursor/toolProtocol';
import type { ChatStreamCallbacks } from '../../types';
import { AgentRuntimeErrorType } from '../../types/error';
import { nanoid } from '../../utils/uuid';
import type { StreamContext, StreamProtocolChunk, StreamToolCallChunkData } from './protocol';
import {
  convertIterableToStream,
  createCallbacksTransformer,
  createSSEProtocolTransformer,
  createTokenSpeedCalculator,
  generateToolCallId,
} from './protocol';

const log = createDebug('lobe-cursor:stream');

export interface CursorStreamOptions {
  callbacks?: ChatStreamCallbacks;
  inputStartAt?: number;
  model?: string;
  /**
   * When true, scan assistant text for a terminal `<aihub:tool_calls>` block.
   * Must stay off unless the request advertised tools (`toolsActive`).
   */
  parseToolCalls?: boolean;
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
  call_id?: string;
  code?: string;
  is_error?: boolean;
  message?: { content?: CursorCliContentPart[] | string; role?: string } | string;
  result?: string;
  subtype?: string;
  text?: string;
  tool_call?: unknown;
  type?: string;
  usage?: CursorCliUsage;
}

const PROVIDER = 'cursor';

/** Keep in sync with `apps/server/src/enterprise/services/cursorAgent/transport.ts`. */
const AUTH_FAILURE_RE =
  /not logged in|unauthori[sz]ed|unauthenticated|\b401\b|authentication|log in|expired token|token expired|invalid token|invalid_api_key/i;

const isRecord = (value: unknown): value is CursorCliEvent =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const pickString = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;

const extractCursorWebSearchPayload = (
  event: CursorCliEvent,
): Record<string, unknown> | undefined => {
  if (event.type !== 'tool_call') return undefined;
  const toolCall = event.tool_call;
  if (!isPlainRecord(toolCall)) return undefined;

  if (isPlainRecord(toolCall.webSearchToolCall)) return toolCall.webSearchToolCall;
  if (isPlainRecord(toolCall.web_search_tool_call)) return toolCall.web_search_tool_call;

  const tool = toolCall.tool;
  if (
    isPlainRecord(tool) &&
    (tool.case === 'webSearchToolCall' || tool.case === 'web_search_tool_call') &&
    isPlainRecord(tool.value)
  ) {
    return tool.value;
  }

  return undefined;
};

const extractCursorWebSearchQuery = (payload: Record<string, unknown>): string | undefined => {
  const args = isPlainRecord(payload.args) ? payload.args : payload;
  return pickString(args.searchTerm) ?? pickString(args.search_term);
};

const upsertNativeSearchQuery = (
  streamContext: StreamContext,
  callId: string | undefined,
  query?: string,
) => {
  const key = callId || `web:${Object.keys(streamContext.nativeSearchQueries ?? {}).length}`;
  streamContext.nativeSearchQueries ??= {};
  const existing = streamContext.nativeSearchQueries[key];
  streamContext.nativeSearchQueries[key] = query || existing || 'Web search';
};

const extractCursorWebSearchCitations = (payload: Record<string, unknown>): ChatCitationItem[] => {
  const result = isPlainRecord(payload.result) ? payload.result : undefined;
  if (!result) return [];

  const nestedResult = isPlainRecord(result.result) ? result.result : undefined;
  const success =
    (isPlainRecord(result.success) ? result.success : undefined) ??
    (nestedResult?.case === 'success' && isPlainRecord(nestedResult.value)
      ? nestedResult.value
      : undefined);
  const references = success && Array.isArray(success.references) ? success.references : undefined;
  if (!references) return [];

  return references.flatMap((source) => {
    if (!isPlainRecord(source)) return [];
    const url = pickString(source.url);
    if (!url) return [];
    return [{ title: pickString(source.title) ?? url, url }];
  });
};

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

const longestPrefixOf = (text: string, token: string): number => {
  const max = Math.min(text.length, token.length - 1);
  for (let length = max; length > 0; length -= 1) {
    if (token.startsWith(text.slice(-length))) return length;
  }
  return 0;
};

const parseEmulatedToolCalls = (inner: string, id: string): StreamProtocolChunk[] | undefined => {
  const trimmed = inner.trim();
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      log('malformed tool_calls JSON: expected a non-empty array');
      return undefined;
    }

    const calls: StreamToolCallChunkData[] = [];
    for (const [index, item] of parsed.entries()) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        log('malformed tool_calls JSON: item %d is not an object', index);
        return undefined;
      }
      const name = (item as { name?: unknown }).name;
      if (typeof name !== 'string' || !name) {
        log('malformed tool_calls JSON: item %d missing name', index);
        return undefined;
      }
      const args = (item as { arguments?: unknown }).arguments;
      const argumentsStr = typeof args === 'string' ? args : JSON.stringify(args ?? {});
      calls.push({
        function: { arguments: argumentsStr, name },
        id: generateToolCallId(index, name),
        index,
        type: 'function',
      });
    }

    return [{ data: calls, id, type: 'tool_calls' }];
  } catch {
    log('malformed tool_calls JSON: %s', trimmed.slice(0, 200));
    return undefined;
  }
};

/**
 * Decide whether `raw` is exactly one terminal tool-call block (optional
 * trailing whitespace only). Anything else is returned as raw text.
 */
const finalizeHeldMarkup = (raw: string, id: string): StreamProtocolChunk[] => {
  if (!raw) return [];
  if (!raw.startsWith(CURSOR_TOOL_CALLS_OPEN)) {
    return [{ data: raw, id, type: 'text' }];
  }

  const closeAt = raw.indexOf(CURSOR_TOOL_CALLS_CLOSE);
  if (closeAt < 0) return [{ data: raw, id, type: 'text' }];

  const end = closeAt + CURSOR_TOOL_CALLS_CLOSE.length;
  const after = raw.slice(end);
  if (after.trim() !== '') return [{ data: raw, id, type: 'text' }];

  const inner = raw.slice(CURSOR_TOOL_CALLS_OPEN.length, closeAt);
  const calls = parseEmulatedToolCalls(inner, id);
  return calls ?? [{ data: raw, id, type: 'text' }];
};

/**
 * Streaming scanner for a *terminal* `<aihub:tool_calls>` block.
 * Text before the first open tag is streamed immediately. Once a candidate
 * open tag is seen, the block and everything after it are held until
 * terminate: emit `tool_calls` only if there is exactly one valid block and
 * nothing but whitespace follows it.
 */
const createCursorToolCallScanner = (id: string) => {
  let hold = '';
  let inCandidate = false;
  let emittedToolCalls = false;

  const consume = (text: string): StreamProtocolChunk[] => {
    if (!text) return [];
    const remaining = hold + text;
    hold = '';

    if (inCandidate) {
      hold = remaining;
      return [];
    }

    const openAt = remaining.indexOf(CURSOR_TOOL_CALLS_OPEN);
    if (openAt >= 0) {
      const before = remaining.slice(0, openAt);
      inCandidate = true;
      hold = remaining.slice(openAt);
      return before ? [{ data: before, id, type: 'text' }] : [];
    }

    const prefixLen = longestPrefixOf(remaining, CURSOR_TOOL_CALLS_OPEN);
    if (prefixLen > 0) {
      const emit = remaining.slice(0, remaining.length - prefixLen);
      hold = remaining.slice(-prefixLen);
      return emit ? [{ data: emit, id, type: 'text' }] : [];
    }

    return [{ data: remaining, id, type: 'text' }];
  };

  const takeHold = (): string => {
    const raw = hold;
    hold = '';
    inCandidate = false;
    return raw;
  };

  const finalize = (): StreamProtocolChunk[] => {
    const chunks = finalizeHeldMarkup(takeHold(), id);
    if (chunks.some((chunk) => chunk.type === 'tool_calls')) emittedToolCalls = true;
    return chunks;
  };

  const flushRaw = (): StreamProtocolChunk[] => {
    const raw = takeHold();
    return raw ? [{ data: raw, id, type: 'text' }] : [];
  };

  return {
    consume,
    finalize,
    flushRaw,
    hasToolCalls: () => emittedToolCalls,
  };
};

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
  const parseToolCalls = options.parseToolCalls === true;
  const scanner = createCursorToolCallScanner(id);
  const streamContext = options.streamStack ?? { id };
  let assistantText = '';
  let emittedAssistant = false;
  let finished = false;
  const citations: ChatCitationItem[] = [];

  const emitWebSearchGrounding = (
    callId: string | undefined,
    query?: string,
  ): StreamProtocolChunk => {
    upsertNativeSearchQuery(streamContext, callId, query);
    return {
      data: {
        ...(citations.length ? { citations: [...citations] } : {}),
        ...(Object.keys(streamContext.nativeSearchQueries ?? {}).length
          ? { searchQueries: Object.values(streamContext.nativeSearchQueries ?? {}) }
          : {}),
      },
      id: callId ?? id,
      type: 'grounding',
    };
  };

  const stopReason = (): string => (scanner.hasToolCalls() ? 'tool_calls' : 'stop');

  const feedAssistant = (text: string): StreamProtocolChunk[] =>
    parseToolCalls ? scanner.consume(text) : [{ data: text, id, type: 'text' }];

  const finishSuccess = (event: CursorCliEvent): StreamProtocolChunk[] => {
    const chunks: StreamProtocolChunk[] = [];
    const resultText = typeof event.result === 'string' ? event.result : '';
    const unseenSuffix =
      emittedAssistant &&
      resultText &&
      resultText.startsWith(assistantText) &&
      resultText.length > assistantText.length
        ? resultText.slice(assistantText.length)
        : '';

    if (parseToolCalls) {
      // Reconcile by raw-input offset: leftover is only text the deltas never
      // saw. Feed it regardless of whether a candidate is already held.
      if (!emittedAssistant && resultText) chunks.push(...scanner.consume(resultText));
      else if (unseenSuffix) chunks.push(...scanner.consume(unseenSuffix));
      chunks.push(...scanner.finalize());
    } else if (!emittedAssistant && resultText) {
      chunks.push({ data: resultText, id, type: 'text' });
    } else if (unseenSuffix) {
      chunks.push({ data: unseenSuffix, id, type: 'text' });
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
    chunks.push({ data: stopReason(), id, type: 'stop' });
    return chunks;
  };

  try {
    for await (const event of events) {
      switch (event.type) {
        case 'thinking': {
          if (event.subtype === 'completed') break;
          const text = typeof event.text === 'string' ? event.text : '';
          if (text) yield { data: text, id, type: 'reasoning' };
          break;
        }

        case 'tool_call': {
          const payload = extractCursorWebSearchPayload(event);
          if (!payload) break;
          const callId = pickString(event.call_id);
          const query = extractCursorWebSearchQuery(payload);
          for (const citation of extractCursorWebSearchCitations(payload)) {
            if (!citations.some((item) => item.url === citation.url)) citations.push(citation);
          }
          yield emitWebSearchGrounding(callId, query);
          break;
        }

        case 'assistant': {
          const text = extractAssistantText(event);
          if (!text) break;
          // Full replay of already-streamed deltas (or a prefix replay).
          if (emittedAssistant && (text === assistantText || text.startsWith(assistantText))) break;
          assistantText += text;
          emittedAssistant = true;
          for (const chunk of feedAssistant(text)) yield chunk;
          break;
        }

        case 'result': {
          finished = true;
          if (event.is_error === true || event.subtype === 'error') {
            for (const chunk of scanner.flushRaw()) yield chunk;
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
            for (const chunk of scanner.flushRaw()) yield chunk;
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

    if (!finished) {
      for (const chunk of parseToolCalls ? scanner.finalize() : scanner.flushRaw()) yield chunk;
      yield { data: stopReason(), id, type: 'stop' };
    }
  } catch (error) {
    for (const chunk of scanner.flushRaw()) yield chunk;
    throw error;
  }
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
