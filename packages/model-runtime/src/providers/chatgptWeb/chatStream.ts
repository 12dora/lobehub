import type {
  ChatGPTWebDoneContext,
  ChatGPTWebDoneResult,
  ChatGPTWebFilePointer,
  ChatGPTWebImagePointer,
} from '../../core/streams/chatgptWeb';
import { ChatGPTWebStream } from '../../core/streams/chatgptWeb';
import type { ChatMethodOptions, ChatStreamPayload, StreamFileData } from '../../types';
import { debugStream } from '../../utils/debugStream';
import { StreamingResponse } from '../../utils/response';
import type { ChatGPTWebClient } from './client';
import {
  buildConversationBody,
  buildFConversationBody,
  buildPrepareBody,
  callerAbortReason,
  createTurnRequestIdentity,
  isCallerAbort,
} from './client';
import { CONDUIT_PREPARE_WAIT_MS } from './constants';
import { createDebugRedactor } from './debugRedactor';
import { resolveChatGPTWebTurn } from './resolveTurnModel';
import { getDurationMs, timing } from './timing';
import type { TurnState } from './turnHelpers';
import {
  describeRequestBody,
  isAbortError,
  isMissingConduitPrepareError,
  isRecoverablePrepareError,
  lastUserMessageId,
  lastUserText,
  replayPendingFirst,
  throwingEvents,
  waitForStreamHeaders,
} from './turnHelpers';
import type {
  ChatGPTWebMessage,
  ChatRequirements,
  ConversationEvent,
  ThinkingEffort,
} from './types';

const STREAM_HARD_CAP_MS = 300_000;
const STREAM_IDLE_MS = 60_000;
const DEBUG_FLAG = 'DEBUG_CHATGPTWEB_CHAT_COMPLETION';

type ConversationBody =
  ReturnType<typeof buildConversationBody> | ReturnType<typeof buildFConversationBody>;

interface BuiltMessages {
  echoHistory: string[];
  inputText: string;
  messages: ChatGPTWebMessage[];
  mimeTypes: string[];
}

interface ChatStreamRuntime {
  buildMessages: (
    messages: ChatStreamPayload['messages'],
    signal?: AbortSignal,
  ) => Promise<BuiltMessages>;
  client: ChatGPTWebClient;
  finalizeTurn: (
    context: ChatGPTWebDoneContext,
    turn: TurnState,
    searchRequested: boolean,
    signal?: AbortSignal,
  ) => Promise<ChatGPTWebDoneResult | undefined>;
  hideTurn: (turn: TurnState, conversationId?: string) => void;
  log: (formatter: string, ...args: unknown[]) => void;
  provider: string;
  releaseSessionContext: () => void;
  resolveFile: (
    pointer: ChatGPTWebFilePointer,
    turn: TurnState,
    signal?: AbortSignal,
  ) => Promise<StreamFileData | undefined>;
  resolveImage: (
    pointer: ChatGPTWebImagePointer,
    turn: TurnState,
    signal?: AbortSignal,
  ) => Promise<string | undefined>;
  sentinelContextKey: string;
  toRuntimeError: (error: unknown) => unknown;
  trackConversation: (
    events: AsyncIterable<ConversationEvent>,
    turn: TurnState,
  ) => AsyncIterable<ConversationEvent>;
}

interface PreparedTurn extends BuiltMessages {
  conduitToken?: string;
  contextKey: string;
  mayFallBack: boolean;
  model: string;
  requirements: ChatRequirements;
  search: boolean;
  thinkingEffort?: ThinkingEffort;
  trackedPrepares: Array<Promise<{ conduitToken?: string }>>;
  turnIdentity: ReturnType<typeof createTurnRequestIdentity>;
}

interface LaunchedConversation {
  body: ConversationBody;
  firstPromise: Promise<IteratorResult<ConversationEvent>>;
  headersPromise: Promise<void>;
  iterator: AsyncIterator<ConversationEvent>;
}

const waitForConduitPrepare = async (
  trackedPrepares: Array<Promise<{ conduitToken?: string }>>,
  signal?: AbortSignal,
): Promise<'settled' | 'timeout'> => {
  const abortReason = callerAbortReason(signal);
  if (abortReason !== undefined) throw abortReason;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), CONDUIT_PREPARE_WAIT_MS);
  });
  let onAbort: (() => void) | undefined;
  const aborted = signal
    ? new Promise<never>((_, reject) => {
        onAbort = () => reject(callerAbortReason(signal));
        signal.addEventListener('abort', onAbort, { once: true });
      })
    : undefined;
  try {
    return await Promise.race([
      Promise.allSettled(trackedPrepares).then(() => 'settled' as const),
      timeout,
      ...(aborted ? [aborted] : []),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
};

const isProTierModel = (model: string): boolean => model.endsWith('-pro');

class ChatStreamRunner {
  private leaseReleased = false;
  private streamConstructed = false;

  constructor(
    private readonly payload: ChatStreamPayload,
    private readonly options: ChatMethodOptions | undefined,
    private readonly runtime: ChatStreamRuntime,
  ) {}

  async run(): Promise<Response> {
    const inputStartAt = Date.now();
    try {
      const prepared = await this.prepareTurn(inputStartAt);
      const launched = await this.openConversation(prepared);
      return this.wireStream(launched, prepared, inputStartAt);
    } catch (error) {
      if (isCallerAbort(this.options?.signal) || isAbortError(error))
        return this.createAbortResponse(error);
      throw this.runtime.toRuntimeError(error);
    } finally {
      if (!this.streamConstructed) this.releaseLease();
    }
  }

  private async prepareTurn(inputStartAt: number): Promise<PreparedTurn> {
    const signal = this.options?.signal;
    const built = await this.runtime.buildMessages(this.payload.messages, signal);
    const search = this.payload.enabledSearch === true;
    const hasAttachments = built.mimeTypes.length > 0;
    // Only dedicated ChatGPT Web effort fields belong on the wire. Generic
    // `reasoning_effort` leftovers on other models must not leak into this turn.
    const resolved = resolveChatGPTWebTurn({
      model: this.payload.model,
      thinkingEffort: this.payload.model.endsWith('-pro')
        ? this.payload.chatgptWebProThinkingEffort
        : this.payload.chatgptWebThinkingEffort,
    });
    // Search, attachments, and explicit effort cannot be expressed by the
    // legacy body, so only a plain turn may degrade to that path.
    const mayFallBack = !search && !hasAttachments && !resolved.thinkingEffort;

    timing('runtime init durationMs=%d', getDurationMs(inputStartAt));
    let lastSentinelStage = Date.now();
    const acquired = await this.runtime.client.acquireSentinelBundle({
      contextKey: this.runtime.sentinelContextKey,
      onProgress: (stage) => {
        timing('sentinel %s (onProgress) durationMs=%d', stage, getDurationMs(lastSentinelStage));
        lastSentinelStage = Date.now();
      },
      signal,
    });
    const turnIdentity = createTurnRequestIdentity();
    // The real client prepares while the user types, so wait briefly here to
    // avoid a conduit-less send that silently routes to a different model. Pro
    // issues both prepare states; a bounded wait still permits a late retry.
    const prepareStates: Array<'sent' | 'success'> = isProTierModel(resolved.model)
      ? ['success', 'sent']
      : ['success'];
    const pendingPrepares = prepareStates.map((clientPrepareState) =>
      this.runtime.client.prepareConversation(
        buildPrepareBody({
          attachmentMimeTypes: hasAttachments ? built.mimeTypes : undefined,
          browserProfile: this.runtime.client.browserProfile,
          clientPrepareState,
          model: resolved.model,
          prompt: lastUserText(built.messages),
          systemHints: search ? ['search'] : [],
          thinkingEffort: resolved.thinkingEffort,
        }),
        { requirements: acquired.requirements, signal, turnIdentity },
      ),
    );
    let latestConduitToken: string | undefined;
    const trackedPrepares = pendingPrepares.map((pending) =>
      pending.then((result) => {
        if (result.conduitToken) latestConduitToken = result.conduitToken;
        return result;
      }),
    );
    const prepareWaitStartedAt = Date.now();
    const prepareWaitOutcome = await waitForConduitPrepare(trackedPrepares, signal);
    timing('prepare wait durationMs=%d', getDurationMs(prepareWaitStartedAt));
    this.logPrepareOutcome(prepareWaitOutcome, latestConduitToken, trackedPrepares);
    return {
      ...built,
      conduitToken: latestConduitToken,
      contextKey: this.runtime.sentinelContextKey,
      mayFallBack,
      model: resolved.model,
      requirements: acquired.requirements,
      search,
      thinkingEffort: resolved.thinkingEffort,
      trackedPrepares,
      turnIdentity,
    };
  }

  private logPrepareOutcome(
    outcome: 'settled' | 'timeout',
    conduitToken: string | undefined,
    trackedPrepares: Array<Promise<{ conduitToken?: string }>>,
  ) {
    this.runtime.log(
      conduitToken
        ? 'sending conversation with a conduit token'
        : 'sending conversation without a conduit token',
    );
    if (outcome !== 'timeout' || conduitToken) return;
    void Promise.allSettled(trackedPrepares).then((results) => {
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value.conduitToken)
          this.runtime.log(
            'prepare returned a conduit token after the wait timed out; conversation already sent without it',
          );
      }
    });
  }

  private async openConversation(prepared: PreparedTurn): Promise<LaunchedConversation> {
    // Build once: a conduit retry must reuse message ids and create_time; only
    // the X-Conduit-Token header may change.
    const body = buildFConversationBody({
      browserProfile: this.runtime.client.browserProfile,
      messages: prepared.messages,
      model: prepared.model,
      search: prepared.search,
      thinkingEffort: prepared.thinkingEffort,
    });
    this.logRequest(body, true, prepared);
    let launched = this.launchStream(body, true, prepared.conduitToken, prepared);
    this.runtime.client.replenishSentinelBundle({ contextKey: prepared.contextKey });
    try {
      await waitForStreamHeaders(launched.headersPromise, launched.firstPromise);
      return launched;
    } catch (error) {
      launched = await this.retryConversation(error, launched, body, prepared);
      return launched;
    }
  }

  private async retryConversation(
    error: unknown,
    launched: LaunchedConversation,
    body: ConversationBody,
    prepared: PreparedTurn,
  ): Promise<LaunchedConversation> {
    const signal = this.options?.signal;
    if (!isMissingConduitPrepareError(error) || isCallerAbort(signal)) throw error;
    const results = await Promise.allSettled(prepared.trackedPrepares);
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<{ conduitToken?: string }> =>
        result.status === 'fulfilled',
    );
    if (fulfilled.length > 0) {
      const retryToken = fulfilled.findLast((result) => result.value.conduitToken)?.value
        .conduitToken;
      this.runtime.log(
        retryToken
          ? 'conversation 4xx missing conduit; retrying once with prepare token'
          : 'conversation 4xx missing conduit; retrying once after prepare (no token)',
      );
      this.abandon(launched.iterator);
      const retried = this.launchStream(body, true, retryToken, prepared);
      await waitForStreamHeaders(retried.headersPromise, retried.firstPromise);
      return retried;
    }

    const allRecoverable =
      results.length > 0 &&
      results.every(
        (result) => result.status === 'rejected' && isRecoverablePrepareError(result.reason),
      );
    if (!prepared.mayFallBack || !allRecoverable) {
      const prepareFailure = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (prepareFailure) throw prepareFailure.reason;
      throw error;
    }

    this.runtime.log(
      'conduit prepare failed (%s); falling back to the plain path',
      String((results[0] as PromiseRejectedResult | undefined)?.reason ?? 'prepare failed'),
    );
    this.abandon(launched.iterator);
    const plainBody = buildConversationBody({
      browserProfile: this.runtime.client.browserProfile,
      messages: prepared.messages,
      model: prepared.model,
      thinkingEffort: prepared.thinkingEffort,
    });
    this.logRequest(plainBody, false, prepared);
    const retried = this.launchStream(plainBody, false, undefined, prepared);
    await waitForStreamHeaders(retried.headersPromise, retried.firstPromise);
    return retried;
  }

  private launchStream(
    body: ConversationBody,
    useFPath: boolean,
    conduitToken: string | undefined,
    prepared: PreparedTurn,
  ): LaunchedConversation {
    let resolveHeaders: () => void = () => {};
    const headersPromise = new Promise<void>((resolve) => {
      resolveHeaders = resolve;
    });
    const conversation = this.runtime.client.streamConversation(body, {
      conduitToken,
      echoHistory: prepared.echoHistory,
      hardCapMs: STREAM_HARD_CAP_MS,
      idleTimeoutMs: STREAM_IDLE_MS,
      onHeaders: resolveHeaders,
      requirements: prepared.requirements,
      signal: this.options?.signal,
      turnIdentity: prepared.turnIdentity,
      useFPath,
    });
    const iterator = conversation[Symbol.asyncIterator]();
    return { body, firstPromise: iterator.next(), headersPromise, iterator };
  }

  private wireStream(
    launched: LaunchedConversation,
    prepared: PreparedTurn,
    inputStartAt: number,
  ): Response {
    // Document recovery must anchor reads to this user message and request time.
    const turn: TurnState = {
      startedAtSec: Date.now() / 1000,
      userMessageId: lastUserMessageId(launched.body),
    };
    // HTTP status errors have already thrown; do not wait for the first event,
    // so consumers can paint generating state as soon as headers succeed.
    const events = this.runtime.trackConversation(
      replayPendingFirst(launched.firstPromise, launched.iterator),
      turn,
    );
    const stream = ChatGPTWebStream(events, {
      callbacks: this.options?.callback,
      inputStartAt,
      inputText: prepared.inputText,
      model: prepared.model,
      onCleanup: ({ conversationId }) => {
        // The created conversation must never remain in account history, and
        // the session lease must live until stream cleanup finishes.
        try {
          this.runtime.hideTurn(turn, conversationId);
        } finally {
          this.releaseLease();
        }
      },
      onDone: (context) =>
        this.runtime.finalizeTurn(context, turn, prepared.search, this.options?.signal),
      provider: this.runtime.provider,
      resolveFile: (pointer) => this.runtime.resolveFile(pointer, turn, this.options?.signal),
      resolveImage: (pointer) => this.runtime.resolveImage(pointer, turn, this.options?.signal),
      signal: this.options?.signal,
    });
    try {
      const response = this.wrapStream(stream);
      this.streamConstructed = true;
      return response;
    } catch (error) {
      void stream.cancel().catch(() => undefined);
      this.abandon(launched.iterator);
      throw error;
    }
  }

  private wrapStream(stream: ReadableStream): Response {
    if (process.env[DEBUG_FLAG] !== '1')
      return StreamingResponse(stream, { headers: this.options?.headers });
    const [production, debug] = stream.tee();
    // Never dump full base64 payloads or signed URLs into the log.
    debugStream(debug.pipeThrough(createDebugRedactor())).catch(console.error);
    return StreamingResponse(production, { headers: this.options?.headers });
  }

  private createAbortResponse(error: unknown): Response {
    // Stopping is not a provider failure; surface the runtime abort terminal.
    const stream = ChatGPTWebStream(throwingEvents(error), {
      callbacks: this.options?.callback,
      model: this.payload.model,
      onCleanup: () => this.releaseLease(),
      provider: this.runtime.provider,
      signal: this.options?.signal,
    });
    try {
      const response = StreamingResponse(stream, { headers: this.options?.headers });
      this.streamConstructed = true;
      return response;
    } catch (wrapError) {
      void stream.cancel().catch(() => undefined);
      throw wrapError;
    }
  }

  private logRequest(body: ConversationBody, useFPath: boolean, prepared: PreparedTurn) {
    if (process.env[DEBUG_FLAG] !== '1') return;
    const flow = useFPath
      ? prepared.search
        ? 'f:search'
        : prepared.mimeTypes.length > 0
          ? 'f:attachments'
          : prepared.thinkingEffort
            ? 'f:effort'
            : 'f:plain'
      : 'conversation';
    this.runtime.log(
      'request: %o',
      describeRequestBody(body, {
        flow,
        model: prepared.model,
        thinkingEffort: prepared.thinkingEffort,
      }),
    );
  }

  private abandon(iterator: AsyncIterator<ConversationEvent>) {
    const closing = iterator.return?.();
    if (closing && typeof (closing as Promise<unknown>).then === 'function')
      void (closing as Promise<unknown>).catch(() => undefined);
  }

  private releaseLease() {
    if (this.leaseReleased) return;
    this.leaseReleased = true;
    this.runtime.releaseSessionContext();
  }
}

export const runChatGPTWebChat = (
  payload: ChatStreamPayload,
  options: ChatMethodOptions | undefined,
  runtime: ChatStreamRuntime,
): Promise<Response> => new ChatStreamRunner(payload, options, runtime).run();
