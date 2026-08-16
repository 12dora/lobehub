import { LOBE_CHAT_OBSERVATION_ID, LOBE_CHAT_TRACE_ID, MESSAGE_CANCEL_FLAT } from '@lobechat/const';
import { parseToolCalls } from '@lobechat/model-runtime';
import type {
  ChatImageChunk,
  ChatMessageError,
  GroundingSearch,
  MessageModerationMetadata,
  MessageToolCall,
  ModelPerformance,
  ModelReasoning,
  ModelReasoningResponseItem,
  ModelUsage,
  ResponseAnimation,
  ResponseAnimationStyle,
} from '@lobechat/types';
import { ChatErrorType } from '@lobechat/types';
import { fetchEventSource } from '@lobechat/utils/client/fetchEventSource/index';
import { nanoid } from '@lobechat/utils/uuid';

import {
  MODERATION_HEADER_ACTION_DOWNGRADE,
  MODERATION_HEADERS,
} from '@/const/platform/contentModeration';

import { getMessageError } from './parseError';

type SSEFinishType = 'done' | 'error' | 'abort' | string;

export type OnFinishHandler = (
  text: string,
  context: {
    grounding?: GroundingSearch;
    images?: ChatImageChunk[];
    /** 内容审计 downgrade notice, decoded from the `x-lobe-moderation-*` response headers. */
    moderation?: MessageModerationMetadata;
    observationId?: string | null;
    reasoning?: ModelReasoning;
    speed?: ModelPerformance;
    toolCalls?: MessageToolCall[];
    traceId?: string | null;
    type?: SSEFinishType;
    usage?: ModelUsage;
  },
) => Promise<void>;

export interface MessageUsageChunk {
  type: 'usage';
  usage: ModelUsage;
}

export interface MessageSpeedChunk {
  speed: ModelPerformance;
  type: 'speed';
}

export interface MessageTextChunk {
  text: string;
  type: 'text';
}
export interface MessageStopChunk {
  reason: string;
  type: 'stop';
}

export interface MessageBase64ImageChunk {
  id: string;
  image: ChatImageChunk;
  images: ChatImageChunk[];
  type: 'base64_image';
}

/**
 * A generated non-image file (pdf/docx/xlsx/…) produced by the model runtime,
 * e.g. ChatGPT Web's code interpreter. Payload mirrors `base64_image`: the bytes
 * travel as a data URI and the client uploads them to the file store.
 */
export interface ChatFileChunk {
  /** data URI: `data:<mimeType>;base64,…` */
  data: string;
  /** temporary client-side id, replaced by the real file id after upload */
  id: string;
  mimeType: string;
  name: string;
  size?: number;
  /** original sandbox path the file was produced at, e.g. `/mnt/data/report.pdf` */
  sourcePath?: string;
}

export interface MessageFileChunk {
  file: ChatFileChunk;
  type: 'file';
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

export interface MessageReasoningChunk {
  signature?: string;
  text?: string;
  type: 'reasoning';
}

export interface MessageGroundingChunk {
  grounding: GroundingSearch;
  type: 'grounding';
}

export interface MessageReasoningPartChunk {
  content: string;
  mimeType?: string;
  partType: 'text' | 'image';
  thoughtSignature?: string;
  type: 'reasoning_part';
}

export interface MessageContentPartChunk {
  content: string;
  mimeType?: string;
  partType: 'text' | 'image';
  thoughtSignature?: string;
  type: 'content_part';
}

interface MessageToolCallsChunk {
  isAnimationActives?: boolean[];
  tool_calls: MessageToolCall[];
  type: 'tool_calls';
}

export interface FetchSSERequestContext {
  apiMode?: string;
  fetchOnClient?: boolean;
  model?: string;
  provider?: string;
}

const readHeader = (headers: Headers, name: string): string | undefined =>
  headers.get(name)?.trim() || undefined;

/**
 * The admin-configured downgrade copy travels `encodeURIComponent`-encoded because HTTP headers are
 * ASCII-only. A malformed percent-escape must never break the reply — decoding failures degrade to
 * the locale default notice.
 */
const readEncodedHeader = (headers: Headers, name: string): string | undefined => {
  const raw = readHeader(headers, name);
  if (!raw) return undefined;

  try {
    return decodeURIComponent(raw) || undefined;
  } catch {
    return undefined;
  }
};

/**
 * Decode the 内容审计 downgrade headers (`MODERATION_HEADERS`) the runtime sets when a request was
 * answered by a fallback model. The metadata is attached to the assistant message so the notice
 * survives a reload — see docs/enterprise/content-moderation.md §3.6.
 *
 * Returns `undefined` for anything but a well-formed downgrade (no header, another action, or a
 * missing effective model): the reply itself is still valid, only the notice is dropped.
 */
export const parseModerationHeaders = (
  headers: Headers,
  requestContext?: FetchSSERequestContext,
): MessageModerationMetadata | undefined => {
  if (readHeader(headers, MODERATION_HEADERS.ACTION) !== MODERATION_HEADER_ACTION_DOWNGRADE)
    return undefined;

  const model = readHeader(headers, MODERATION_HEADERS.MODEL);
  if (!model) return undefined;

  // The runtime may omit the provider header when the downgrade stays inside the same provider.
  const provider = readHeader(headers, MODERATION_HEADERS.PROVIDER) ?? requestContext?.provider;
  if (!provider) return undefined;

  return {
    action: 'downgrade',
    category: readHeader(headers, MODERATION_HEADERS.CATEGORY),
    message: readEncodedHeader(headers, MODERATION_HEADERS.MESSAGE),
    model,
    originalModel: requestContext?.model ?? model,
    originalProvider: requestContext?.provider ?? provider,
    provider,
    recordId: readHeader(headers, MODERATION_HEADERS.RECORD),
  };
};

export interface FetchSSEOptions {
  fetcher?: typeof fetch;
  onAbort?: (text: string) => Promise<void>;
  onErrorHandle?: (error: ChatMessageError) => void;
  onFinish?: OnFinishHandler;
  onMessageHandle?: (
    chunk:
      | MessageTextChunk
      | MessageToolCallsChunk
      | MessageReasoningChunk
      | MessageReasoningPartChunk
      | MessageContentPartChunk
      | MessageGroundingChunk
      | MessageUsageChunk
      | MessageBase64ImageChunk
      | MessageFileChunk
      | MessageSpeedChunk
      | MessageStopChunk,
  ) => void;
  requestContext?: FetchSSERequestContext;
  responseAnimation?: ResponseAnimation;
}

const START_ANIMATION_SPEED = 10; // Default starting speed

const createSmoothMessage = (params: {
  onTextUpdate: (delta: string, text: string) => void;
  startSpeed?: number;
}) => {
  const { startSpeed = START_ANIMATION_SPEED } = params;

  let buffer = '';
  const outputQueue: string[] = [];
  let isAnimationActive = false;
  let animationFrameId: number | null = null;
  let lastFrameTime = 0;
  let accumulatedTime = 0;
  let currentSpeed = startSpeed;
  let lastQueueLength = 0; // Record the queue length from the previous frame

  const stopAnimation = () => {
    isAnimationActive = false;
    if (animationFrameId !== null) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
  };

  const startAnimation = (speed = startSpeed) => {
    return new Promise<void>((resolve) => {
      if (isAnimationActive) {
        resolve();
        return;
      }

      isAnimationActive = true;
      lastFrameTime = performance.now();
      accumulatedTime = 0;
      currentSpeed = speed;
      lastQueueLength = 0; // Reset previous frame queue length

      const updateText = (timestamp: number) => {
        if (!isAnimationActive) {
          if (animationFrameId !== null) {
            cancelAnimationFrame(animationFrameId);
          }
          resolve();
          return;
        }

        const frameDuration = timestamp - lastFrameTime;
        lastFrameTime = timestamp;
        accumulatedTime += frameDuration;

        let charsToProcess = 0;
        if (outputQueue.length > 0) {
          // Smoother speed adjustment
          const targetSpeed = Math.max(speed, outputQueue.length);
          // Adjust speed change rate based on queue length changes
          const speedChangeRate = Math.abs(outputQueue.length - lastQueueLength) * 0.0008 + 0.005;
          currentSpeed += (targetSpeed - currentSpeed) * speedChangeRate;

          charsToProcess = Math.floor((accumulatedTime * currentSpeed) / 1000);
        }

        if (charsToProcess > 0) {
          accumulatedTime -= (charsToProcess * 1000) / currentSpeed;

          const actualChars = Math.min(charsToProcess, outputQueue.length);
          // actualChars = Math.min(speed, actualChars); // Speed upper limit

          // if (actualChars * 2 < outputQueue.length && /[\dA-Za-z]/.test(outputQueue[actualChars])) {
          //   actualChars *= 2;
          // }

          const charsToAdd = outputQueue.splice(0, actualChars).join('');
          buffer += charsToAdd;
          params.onTextUpdate(charsToAdd, buffer);
        }

        lastQueueLength = outputQueue.length; // Update previous frame queue length

        if (outputQueue.length > 0 && isAnimationActive) {
          animationFrameId = requestAnimationFrame(updateText);
        } else {
          isAnimationActive = false;
          animationFrameId = null;
          resolve();
        }
      };

      animationFrameId = requestAnimationFrame(updateText);
    });
  };

  const pushToQueue = (text: string) => {
    outputQueue.push(...text.split(''));
  };

  const flushQueue = () => {
    if (outputQueue.length === 0) return;
    const remaining = outputQueue.splice(0).join('');
    buffer += remaining;
    params.onTextUpdate(remaining, buffer);
  };

  return {
    flushQueue,
    isAnimationActive,
    isTokenRemain: () => outputQueue.length > 0,
    pushToQueue,
    startAnimation,
    stopAnimation,
  };
};

export const standardizeAnimationStyle = (
  animationStyle?: ResponseAnimation,
): Exclude<ResponseAnimation, ResponseAnimationStyle> => {
  return typeof animationStyle === 'object' ? animationStyle : { text: animationStyle };
};

/**
 * Fetch data using stream method
 */

export const fetchSSE = async (url: string, options: RequestInit & FetchSSEOptions = {}) => {
  let toolCalls: undefined | MessageToolCall[];
  let triggerOnMessageHandler = false;

  let finishedType: SSEFinishType = 'done';
  let response!: Response;
  const fetchStartTime = Date.now();

  const { text, speed: smoothingSpeed } = standardizeAnimationStyle(
    options.responseAnimation ?? {},
  );
  const shouldSkipTextProcessing = text === 'none';
  const textSmoothing = text === 'smooth';

  // Add text buffer and timer related variables
  let textBuffer = '';
  let bufferTimer: ReturnType<typeof setTimeout> | null = null;
  const BUFFER_INTERVAL = 300; // 300ms

  const flushTextBuffer = () => {
    if (textBuffer) {
      options.onMessageHandle?.({ text: textBuffer, type: 'text' });
      textBuffer = '';
    }
  };

  let output = '';
  const textController = createSmoothMessage({
    onTextUpdate: (delta, text) => {
      output = text;
      options.onMessageHandle?.({ text: delta, type: 'text' });
    },
    startSpeed: smoothingSpeed,
  });

  let thinking = '';
  let thinkingSignature: string | undefined;
  const reasoningResponseItems: ModelReasoningResponseItem[] = [];

  const thinkingController = createSmoothMessage({
    onTextUpdate: (delta, text) => {
      thinking = text;
      options.onMessageHandle?.({ text: delta, type: 'reasoning' });
    },
    startSpeed: smoothingSpeed,
  });

  let thinkingBuffer = '';
  let thinkingBufferTimer: ReturnType<typeof setTimeout> | null = null;

  // Create a function to handle buffer flushing
  const flushThinkingBuffer = () => {
    if (thinkingBuffer) {
      options.onMessageHandle?.({ text: thinkingBuffer, type: 'reasoning' });
      thinkingBuffer = '';
    }
  };

  let grounding: GroundingSearch | undefined = undefined;
  let usage: ModelUsage | undefined = undefined;
  const images: ChatImageChunk[] = [];
  let speed: ModelPerformance | undefined = undefined;

  await fetchEventSource(url, {
    body: options.body,
    fetch: options?.fetcher,
    headers: options.headers as Record<string, string>,
    method: options.method,
    onerror: (error) => {
      if (error === MESSAGE_CANCEL_FLAT || (error as TypeError).name === 'AbortError') {
        finishedType = 'abort';
        options?.onAbort?.(output);
        textController.stopAnimation();
      } else {
        finishedType = 'error';

        const elapsedMs = Date.now() - fetchStartTime;
        const networkStatus = typeof navigator !== 'undefined' ? navigator.onLine : undefined;

        const contextBody = {
          ...options.requestContext,
          elapsedMs,
          networkStatus,
        };

        options.onErrorHandle?.(
          error.type
            ? error
            : {
                body: {
                  message: error.message,
                  name: error.name,
                  ...contextBody,
                },
                message: error.message,
                type: ChatErrorType.UnknownChatFetchError,
              },
        );
        return;
      }
    },
    onmessage: (ev) => {
      triggerOnMessageHandler = true;
      let data;
      try {
        data = JSON.parse(ev.data);
      } catch (e) {
        console.warn('parse error:', e);
        options.onErrorHandle?.({
          body: {
            context: {
              chunk: ev.data,
              error: { message: (e as Error).message, name: (e as Error).name },
            },
            message:
              'chat response streaming chunk parse error, please contact your API Provider to fix it.',
          },
          message: 'parse error',
          type: 'StreamChunkError',
        });

        return;
      }

      switch (ev.event) {
        case 'error': {
          finishedType = 'error';
          options.onErrorHandle?.(data);
          break;
        }

        case 'base64_image': {
          const id = 'tmp_img_' + nanoid();
          const item = { data, id, isBase64: true };
          images.push(item);

          options.onMessageHandle?.({ id, image: item, images, type: 'base64_image' });
          break;
        }

        case 'file': {
          // payload: { data: 'data:<mime>;base64,…', mimeType, name, size?, sourcePath? }
          // `data`, `mimeType` and `name` are all required by the contract: a file
          // without a name can neither be uploaded with a sane filename nor rendered,
          // so an incomplete / wrongly typed payload is dropped rather than half-handled.
          const payload = data as Partial<Omit<ChatFileChunk, 'id'>> | undefined;
          if (
            !isNonEmptyString(payload?.data) ||
            !isNonEmptyString(payload?.mimeType) ||
            !isNonEmptyString(payload?.name)
          )
            break;

          options.onMessageHandle?.({
            file: {
              data: payload.data,
              id: 'tmp_file_' + nanoid(),
              mimeType: payload.mimeType,
              name: payload.name,
              // optional fields: keep them only when they're actually usable
              size:
                typeof payload.size === 'number' &&
                Number.isFinite(payload.size) &&
                payload.size >= 0
                  ? payload.size
                  : undefined,
              sourcePath: isNonEmptyString(payload.sourcePath) ? payload.sourcePath : undefined,
            },
            type: 'file',
          });
          break;
        }

        case 'text': {
          // skip empty text
          if (!data) break;

          if (shouldSkipTextProcessing) {
            output += data;
            options.onMessageHandle?.({ text: data, type: 'text' });
          } else if (textSmoothing) {
            textController.pushToQueue(data);

            if (!textController.isAnimationActive) textController.startAnimation();
          } else {
            output += data;

            // Use buffer mechanism
            textBuffer += data;

            // If timer not set yet, create one
            if (!bufferTimer) {
              bufferTimer = setTimeout(() => {
                flushTextBuffer();
                bufferTimer = null;
              }, BUFFER_INTERVAL);
            }
          }

          break;
        }

        case 'usage': {
          usage = data;
          options.onMessageHandle?.({ type: 'usage', usage: data });
          break;
        }

        case 'speed': {
          speed = data;
          options.onMessageHandle?.({ speed: data, type: 'speed' });
          break;
        }

        case 'grounding': {
          grounding = data;
          options.onMessageHandle?.({ grounding: data, type: 'grounding' });
          break;
        }

        case 'reasoning_signature': {
          // Server guarantees string payloads on this event; guard against object
          // payloads so a malformed stream can't corrupt the persisted signature.
          if (typeof data === 'string') thinkingSignature = data;
          break;
        }

        case 'reasoning_response_item': {
          reasoningResponseItems.push(data as ModelReasoningResponseItem);
          break;
        }

        case 'stop': {
          options.onMessageHandle?.({ reason: data, type: 'stop' });
          break;
        }

        case 'reasoning': {
          if (textSmoothing) {
            thinkingController.pushToQueue(data);

            if (!thinkingController.isAnimationActive) thinkingController.startAnimation();
          } else {
            thinking += data;

            // Use buffer mechanism
            thinkingBuffer += data;

            // If timer not set yet, create one
            if (!thinkingBufferTimer) {
              thinkingBufferTimer = setTimeout(() => {
                flushThinkingBuffer();
                thinkingBufferTimer = null;
              }, BUFFER_INTERVAL);
            }
          }

          break;
        }

        case 'reasoning_part': {
          // For reasoning_part, accumulate thinking content
          if (data.partType === 'text' && data.content) {
            thinking += data.content;
          }
          options.onMessageHandle?.({
            content: data.content,
            mimeType: data.mimeType,
            partType: data.partType,
            thoughtSignature: data.thoughtSignature,
            type: ev.event,
          });
          break;
        }

        case 'content_part': {
          // For content_part, accumulate text content to output
          // This is critical for Gemini 2.5 models which use content_part instead of text events
          if (data.partType === 'text' && data.content) {
            output += data.content;
          }
          options.onMessageHandle?.({
            content: data.content,
            mimeType: data.mimeType,
            partType: data.partType,
            thoughtSignature: data.thoughtSignature,
            type: ev.event,
          });
          break;
        }

        case 'tool_calls': {
          // get finial
          // if there is no tool calls, we should initialize the tool calls
          if (!toolCalls) toolCalls = [];
          toolCalls = parseToolCalls(toolCalls, data);
          options.onMessageHandle?.({ tool_calls: toolCalls, type: 'tool_calls' });
        }
      }
    },
    onopen: async (res) => {
      response = res.clone();
      // If not ok, it means there is a request error
      if (!response.ok) {
        throw await getMessageError(res);
      }
    },
    signal: options.signal,
  });

  // only call onFinish when response is available
  // so like abort, we don't need to call onFinish
  if (response) {
    textController.stopAnimation();
    thinkingController.stopAnimation();

    // Ensure all buffered data is processed
    if (bufferTimer) {
      clearTimeout(bufferTimer);
      flushTextBuffer();
    }

    if (thinkingBufferTimer) {
      clearTimeout(thinkingBufferTimer);
      flushThinkingBuffer();
    }

    if (response.ok) {
      // if there is no onMessageHandler, we should call onHandleMessage first
      if (!triggerOnMessageHandler) {
        output = await response.clone().text();
        options.onMessageHandle?.({ text: output, type: 'text' });
      }

      const traceId = response.headers.get(LOBE_CHAT_TRACE_ID);
      const observationId = response.headers.get(LOBE_CHAT_OBSERVATION_ID);
      const moderation = parseModerationHeaders(response.headers, options.requestContext);

      textController.flushQueue();
      thinkingController.flushQueue();

      await options?.onFinish?.(output, {
        grounding,
        images: images.length > 0 ? images : undefined,
        moderation,
        observationId,
        reasoning: (() => {
          /**
           * Non-streaming Responses conversion emits reasoning items without summary
           * deltas; derive visible thinking text from item summaries when nothing was
           * streamed so the summary renders instead of being replay-only state.
           */
          const responseItemsThinking = reasoningResponseItems
            .flatMap(({ summary }) => summary ?? [])
            .map(({ text }) => text)
            .filter(Boolean)
            .join('\n');
          const reasoningContent = thinking || responseItemsThinking || undefined;

          return reasoningContent || thinkingSignature || reasoningResponseItems.length > 0
            ? {
                content: reasoningContent,
                responseItems:
                  reasoningResponseItems.length > 0 ? reasoningResponseItems : undefined,
                signature: thinkingSignature,
              }
            : undefined;
        })(),
        speed,
        toolCalls,
        traceId,
        type: finishedType,
        usage,
      });
    }
  }

  return response;
};
