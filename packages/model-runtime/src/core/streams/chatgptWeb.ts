import type { GroundingSearch, ModelUsage } from '@lobechat/types';

import type { ConversationEvent } from '../../providers/chatgptWeb/client';
import {
  estimateTokens,
  isCallerAbort,
  isChatGPTWebError,
  toAgentRuntimeErrorType,
} from '../../providers/chatgptWeb/client';
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

export interface ChatGPTWebImagePointer {
  assetPointer: string;
  fileId: string;
  pointerKind: 'file-service' | 'sediment';
}

export interface ChatGPTWebDoneContext {
  /** whether a `grounding` chunk was already emitted from in-stream citations */
  citationsEmitted: boolean;
  conversationId?: string;
  /** whether the upstream reported the turn as finished */
  endTurn: boolean;
  /**
   * whether an `error` chunk was already emitted (stream failure, moderation
   * block, upstream error message). The turn is over: recovering an answer that
   * failed is a 4-minute wait for nothing.
   */
  hadError: boolean;
  /** whether the stream carried any output at all (false ⇒ the turn went async) */
  hadOutput: boolean;
  /** whether the stream carried answer text */
  hadText: boolean;
  /**
   * The upstream never finished the turn (a resume leg failed or ran out of
   * budget), so {@link text} may be a truncated prefix of the real answer.
   */
  recoveryRequired: boolean;
  /** search was requested, or the upstream reported that it used its search tool */
  searchUsed: boolean;
  /** the answer text already streamed — recovery must only emit what follows it */
  text: string;
}

export interface ChatGPTWebDoneResult {
  grounding?: GroundingSearch;
  /** Answer text recovered after the stream ended empty (async/background turn). */
  text?: string;
}

export interface ChatGPTWebStreamOptions {
  callbacks?: ChatStreamCallbacks;
  /** surface unmapped upstream events as `data` chunks (the client ignores them) */
  debug?: boolean;
  inputStartAt?: number;
  /** the joined prompt text, used for the heuristic usage estimate */
  inputText?: string;
  model?: string;
  /**
   * Runs in a `finally`, so it fires on success, on failure AND on a caller
   * abort — unlike {@link onDone}, which a cancelled turn never reaches. Use it
   * for cleanup that must always happen (hiding the created conversation), never
   * for work that talks back to the stream.
   */
  onCleanup?: (context: { aborted: boolean; conversationId?: string }) => void;
  /**
   * Called once after the upstream `done` event. Citations are only committed to
   * the conversation document, and a turn with an explicit thinking effort
   * finishes asynchronously (empty SSE) — both are recovered here.
   */
  onDone?: (context: ChatGPTWebDoneContext) => Promise<ChatGPTWebDoneResult | undefined | void>;
  provider?: string;
  /**
   * Resolve an image pointer into a `data:` URI. Awaited inline, so generated
   * images keep their position relative to the surrounding text.
   */
  resolveImage?: (pointer: ChatGPTWebImagePointer) => Promise<string | undefined>;
  /** The CALLER's abort signal — the only one that means "the user stopped". */
  signal?: AbortSignal;
  streamStack?: StreamContext;
}

const toCitationList = (citations: { title?: string; url: string }[]) =>
  citations
    .filter((citation) => !!citation.url)
    .map((citation) => ({ title: citation.title, url: citation.url }));

/**
 * Only a REAL caller cancellation ends the turn as `stop: "abort"`.
 *
 * The protocol core rethrows the caller's own `AbortError` untouched and wraps
 * everything of its own — the hard cap, the idle timeout — into a typed
 * `ChatGPTWebError('timeout')`. Matching on message substrings instead (the
 * previous behaviour) reported a provider timeout as "the user pressed stop",
 * which hides a failed turn behind a clean stop.
 */
const isCallerAbortError = (error: unknown, signal?: AbortSignal): boolean => {
  if (isChatGPTWebError(error)) return false;
  if (isCallerAbort(signal)) return true;
  return (error as { name?: unknown } | undefined)?.name === 'AbortError';
};

/** ReadableStream → AsyncIterable, without relying on the (non-universal) async iterator. */
async function* iterateReadable<T>(stream: ReadableStream<T>): AsyncGenerator<T, void, undefined> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Turn the protocol core's {@link ConversationEvent} stream into the app's
 * {@link StreamProtocolChunk} sequence.
 *
 * Async by design: image pointers have to be downloaded and citations fetched
 * from the conversation document, and both must stay ordered against the text.
 */
export async function* transformChatGPTWebEvents(
  events: AsyncIterable<ConversationEvent>,
  options: ChatGPTWebStreamOptions,
): AsyncGenerator<StreamProtocolChunk, void, undefined> {
  const id = options.streamStack?.id || `chat_${nanoid()}`;
  const stack = options.streamStack;

  let conversationId: string | undefined;
  let outputText = '';
  let outputReasoning = '';
  let sawReasoningText = false;
  let searchUsed = false;
  // a stack that already reported citations must not receive a second grounding chunk
  let citationsEmitted = Boolean(stack?.returnedCitation);
  let hadOutput = false;
  let hadError = false;
  let endTurn = false;
  let recoveryRequired = false;
  let aborted = false;
  let finished = false;

  const emitGrounding = (data: GroundingSearch): StreamProtocolChunk => {
    citationsEmitted = true;
    if (stack) stack.returnedCitation = true;
    return { data, id, type: 'grounding' };
  };

  /** Every error chunk goes through here so `hadError` can never drift. */
  const emitError = (error: unknown, message: string, type?: string): StreamProtocolChunk => {
    hadError = true;
    return {
      data: { message, type: type ?? toAgentRuntimeErrorType(error) },
      id,
      type: 'error',
    };
  };

  try {
    try {
      for await (const event of events) {
        switch (event.type) {
          case 'conversation.start': {
            conversationId = event.conversationId;
            break;
          }

          case 'text.delta': {
            if (!event.delta) break;
            outputText += event.delta;
            hadOutput = true;
            yield { data: event.delta, id, type: 'text' };
            break;
          }

          case 'reasoning.delta': {
            if (!event.delta) break;
            sawReasoningText = true;
            hadOutput = true;
            outputReasoning += event.delta;
            yield { data: event.delta, id, type: 'reasoning' };
            break;
          }

          case 'reasoning.done': {
            // The recap ("Worked for a couple of seconds") is only worth showing
            // when the upstream never streamed any thinking text of its own.
            if (!sawReasoningText && event.recap) {
              outputReasoning += event.recap;
              yield { data: event.recap, id, type: 'reasoning' };
            }
            break;
          }

          case 'citations': {
            if (citationsEmitted || event.citations.length === 0) break;
            yield emitGrounding({ citations: toCitationList(event.citations) });
            break;
          }

          case 'image.pointer': {
            if (!options.resolveImage) break;
            try {
              const dataUri = await options.resolveImage({
                assetPointer: event.assetPointer,
                fileId: event.fileId,
                pointerKind: event.pointerKind,
              });
              if (dataUri) {
                hadOutput = true;
                yield { data: dataUri, id, type: 'base64_image' };
              }
            } catch (error) {
              // the user pressing stop must END the turn, not be swallowed as
              // "one image failed to resolve" and reported as a clean stop
              if (isCallerAbortError(error, options.signal)) throw error;
              // a missing inline image must not kill the answer
            }
            break;
          }

          case 'moderation': {
            if (!event.blocked) break;
            yield emitError(
              undefined,
              'The request was blocked by the ChatGPT content policy.',
              AgentRuntimeErrorType.ProviderContentPolicyViolation,
            );
            break;
          }

          case 'metadata': {
            if (event.turnUseCase === 'search' || event.toolInvoked) searchUsed = true;
            if (options.debug) yield { data: event, id, type: 'data' };
            break;
          }

          case 'error': {
            hadError = true;
            yield {
              data: {
                body: event.code ? { code: event.code } : undefined,
                message: event.message,
                type: AgentRuntimeErrorType.ProviderBizError,
              },
              id,
              type: 'error',
            };
            break;
          }

          case 'handoff': {
            // Turn bookkeeping the protocol client consumes itself. NEVER re-emit
            // it, not even under `debug`: it carries the resume-token JWT.
            break;
          }

          case 'done': {
            conversationId = event.conversationId ?? conversationId;
            endTurn = event.endTurn === true;
            recoveryRequired = event.recoveryRequired === true;
            finished = true;
            break;
          }

          default: {
            if (options.debug) yield { data: event, id, type: 'data' };
            break;
          }
        }

        if (finished) break;
      }
    } catch (error) {
      if (isCallerAbortError(error, options.signal)) aborted = true;
      // A hard cap / idle timeout mid-turn is a FAILED turn: exactly one error
      // chunk, and `hadError` then keeps the recovery poll from running for
      // another four minutes on top of it.
      else yield emitError(error, error instanceof Error ? error.message : String(error));
    }

    if (aborted) {
      yield { data: 'abort', id, type: 'stop' };
      return;
    }

    if (options.onDone) {
      try {
        const wasEmitted = citationsEmitted;
        const result = await options.onDone({
          citationsEmitted,
          conversationId,
          endTurn,
          hadError,
          hadOutput,
          hadText: outputText.length > 0,
          recoveryRequired,
          searchUsed,
          text: outputText,
        });

        if (result?.text) {
          outputText += result.text;
          hadOutput = true;
          yield { data: result.text, id, type: 'text' };
        }

        const grounding = result?.grounding;
        if (
          !wasEmitted &&
          grounding &&
          (grounding.citations?.length || grounding.searchQueries?.length)
        )
          yield emitGrounding(grounding);
      } catch (error) {
        // The recovery path owns the answer of a handed-off turn: when it gives up
        // (its deadline), saying nothing would present an empty turn as a clean
        // success. Surface it — a caller stop still ends as an abort.
        if (isCallerAbortError(error, options.signal)) {
          aborted = true;
          yield { data: 'abort', id, type: 'stop' };
          return;
        }
        yield emitError(error, error instanceof Error ? error.message : String(error));
      }
    }

    const inputTextTokens = estimateTokens(options.inputText);
    const outputTextTokens = estimateTokens(outputText);
    const outputReasoningTokens = estimateTokens(outputReasoning);
    const totalOutputTokens = outputTextTokens + outputReasoningTokens;

    // chatgpt.com never reports token counts, so this is an explicit estimate. No
    // cost is attached — a ChatGPT subscription is not metered per token.
    yield {
      data: {
        inputTextTokens,
        outputReasoningTokens: outputReasoningTokens || undefined,
        outputTextTokens,
        totalInputTokens: inputTextTokens,
        totalOutputTokens,
        totalTokens: inputTextTokens + totalOutputTokens,
      } as ModelUsage,
      id,
      type: 'usage',
    };

    yield { data: 'stop', id, type: 'stop' };
  } finally {
    // success, failure, abort AND consumer disconnect all land here
    options.onCleanup?.({ aborted, conversationId });
  }
}

export const ChatGPTWebStream = (
  events: AsyncIterable<ConversationEvent> | ReadableStream<ConversationEvent>,
  options: ChatGPTWebStreamOptions = {},
): ReadableStream<Uint8Array> => {
  const streamStack: StreamContext = options.streamStack ?? { id: `chat_${nanoid()}` };

  const iterable =
    events instanceof ReadableStream
      ? iterateReadable(events)
      : (events as AsyncIterable<ConversationEvent>);

  const chunks = transformChatGPTWebEvents(iterable, { ...options, streamStack });

  return convertIterableToStream(chunks, { model: options.model, provider: options.provider })
    .pipeThrough(
      createTokenSpeedCalculator((chunk) => chunk, {
        inputStartAt: options.inputStartAt,
        streamStack,
      }),
    )
    .pipeThrough(createSSEProtocolTransformer((chunk) => chunk, streamStack))
    .pipeThrough(createCallbacksTransformer(options.callbacks, { streamStack }));
};
