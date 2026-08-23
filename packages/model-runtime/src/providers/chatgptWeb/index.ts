import type { ChatModelCard } from '@lobechat/types';
import createDebug from 'debug';

import type { RuntimeBrowserDeviceProfile } from '../../browserProfile';
import type { LobeRuntimeAI } from '../../core/BaseAI';
import type {
  ChatGPTWebDoneContext,
  ChatGPTWebDoneResult,
  ChatGPTWebFilePointer,
  ChatGPTWebImagePointer,
  ChatGPTWebRecoveredFile,
} from '../../core/streams/chatgptWeb';
import type {
  ChatMethodOptions,
  ChatStreamPayload,
  CreateImageMethodOptions,
  GenerateObjectOptions,
  GenerateObjectPayload,
  StreamFileData,
} from '../../types';
import { AgentRuntimeErrorType } from '../../types/error';
import type { CreateImagePayload, CreateImageResponse } from '../../types/image';
import { AgentRuntimeError } from '../../utils/createError';
import { buildChatGPTWebMessages } from './chatPayload';
import { runChatGPTWebChat } from './chatStream';
import type { Citation, ConversationEvent } from './client';
import {
  abortableSleep,
  bytesToBase64,
  callerAbortReason,
  ChatGPTWebClient,
  ChatGPTWebError,
  composeSignals,
  deriveSentinelContextKey,
  extractCitations,
  isBentoOnlyText,
  isChatGPTWebError,
  MAX_DOWNLOAD_BYTES,
  RETRYABLE_POLL_STATUSES,
  sanitizeAnnotations,
  stripBentoLayout,
  toAgentRuntimeErrorType,
  turnAnswerMessage,
} from './client';
import { createChatGPTWebImage } from './createImage';
import { runChatGPTWebGenerateObject } from './generateObject';
import { readImageMimeType } from './imageDimensions';
import { extractSandboxFiles, resolveFileMimeType, sandboxFileName } from './interpreterFiles';
import type { ChatGPTWebSessionContext } from './sessionContext';
import type { TurnState } from './turnHelpers';
import {
  describeRequestBody,
  messageParts,
  toGroundingCitation,
  undeliveredSuffix,
} from './turnHelpers';
import { uploadNamespace } from './uploadCache';

export { ChatGPTWebClient } from './client';
export { describeRequestBody, undeliveredSuffix };

const log = createDebug('lobe-chatgptweb:runtime');

const DEFAULT_PROVIDER = 'chatgptweb';

/** Slugs the web app advertises but that cannot serve a normal chat turn. */
const HIDDEN_MODEL_SLUGS = new Set(['research']);
const isHiddenModelSlug = (slug: string) => HIDDEN_MODEL_SLUGS.has(slug) || slug.endsWith('-wm');

/** Fallback context window for a live slug the catalogue does not carry yet. */
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;

const CITATION_FETCH_TIMEOUT_MS = 10_000;
const HIDE_TIMEOUT_MS = 5000;
/** Background (thinking-effort) turns: how long to wait for the written answer. */
const ANSWER_POLL_BUDGET_MS = 240_000;
const ANSWER_POLL_INTERVAL_MS = 3000;

/** `AbortSignal.timeout` is not in every runtime we ship to. */
const timeoutSignal = (ms: number): AbortSignal | undefined => {
  const factory = (AbortSignal as { timeout?: (ms: number) => AbortSignal }).timeout;
  return factory ? factory.call(AbortSignal, ms) : undefined;
};

/**
 * A deadline that aborts with a TYPED timeout (so it can be told apart from the
 * caller's own stop) and whose timer is disarmed by `cleanup()`.
 */
const timeoutSignalHandle = (ms: number): { cleanup: () => void; signal: AbortSignal } => {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new ChatGPTWebError('timeout', `recovery exceeded ${ms}ms`)),
    ms,
  );
  return { cleanup: () => clearTimeout(timer), signal: controller.signal };
};

/** Shared settings for a live slug the catalogue does not carry yet. */
const LIVE_MODEL_SETTINGS: NonNullable<ChatModelCard['settings']> = {
  searchImpl: 'params',
  searchProvider: DEFAULT_PROVIDER,
};

export interface LobeChatGPTWebParams {
  /** ChatGPT Web access token (OAuth or pasted). */
  apiKey?: string;
  baseURL?: string;
  browserProfile?: RuntimeBrowserDeviceProfile;
  /**
   * Stable AIHub connection handle (`platform:<id>` / `user:<uid>:<ws>:<id>`).
   * Used as the Sentinel pool key when no Browser Session Context could be
   * bound (degraded fallback profile). Never a raw device id.
   */
  browserSessionAccountId?: string;
  /**
   * Opaque Browser Session Context key from C1. When omitted, a provisional
   * key is derived from the device/session/profile already on the client.
   */
  browserSessionContextKey?: string;
  chatgptAccountId?: string;
  chatgptDeviceId?: string;
  /** Test seam — inject a pre-built (or fake) protocol client. */
  client?: ChatGPTWebClient;
  fetch?: typeof fetch;
  id?: string;
  /** Bound Browser Session Context. Owns page id, jar key, and bootstrap cache. */
  sessionContext?: ChatGPTWebSessionContext;
  userId?: string;
}

export class LobeChatGPTWebAI implements LobeRuntimeAI {
  baseURL = 'https://chatgpt.com/backend-api';
  provider: string;

  private readonly client: ChatGPTWebClient;
  /** Account-scoped Sentinel fallback when no Browser Session Context is bound. */
  private readonly browserSessionAccountId?: string;
  /**
   * Opaque C1 context key. Conversation turns pass this into the Sentinel
   * bundle pool so a later Browser Session Context can share/invalidate it.
   */
  private readonly browserSessionContextKey?: string;
  /**
   * Namespace for the process-wide upload cache. Uploaded file ids are
   * account-scoped, so the cache MUST NOT be shared between credentials — see
   * {@link uploadNamespace}.
   */
  private readonly uploadNamespace?: string;
  private readonly sessionContext?: ChatGPTWebSessionContext;

  constructor({
    apiKey,
    baseURL,
    browserProfile,
    browserSessionAccountId,
    browserSessionContextKey,
    chatgptAccountId,
    chatgptDeviceId,
    client,
    fetch: customFetch,
    id,
    sessionContext,
  }: LobeChatGPTWebParams = {}) {
    if (!client && !apiKey)
      throw AgentRuntimeError.createError(AgentRuntimeErrorType.InvalidProviderAPIKey);

    this.provider = id || DEFAULT_PROVIDER;
    if (baseURL) this.baseURL = baseURL;
    this.browserSessionAccountId = browserSessionAccountId;
    this.sessionContext = sessionContext;
    this.browserSessionContextKey = sessionContext?.contextId ?? browserSessionContextKey;

    this.client =
      client ??
      new ChatGPTWebClient({
        accessToken: apiKey!,
        accountId: chatgptAccountId,
        browserProfile,
        deviceId: chatgptDeviceId,
        fetch: customFetch,
        ...(sessionContext ? { sessionContext } : {}),
      });

    this.uploadNamespace = uploadNamespace(chatgptAccountId ?? this.client.accountId, apiKey);

    // Managed Browser Session Context only. A fallback-profile key has no
    // session lifecycle, so keep-warm would leak the mint closure (and the
    // credential it closes over) until process exit.
    if (this.browserSessionContextKey && typeof this.client.keepSentinelWarm === 'function') {
      this.client.keepSentinelWarm(this.browserSessionContextKey);
    }
  }

  /**
   * Prefer the Browser Session Context id so the Sentinel pool is account-scoped.
   * On the degraded fallback profile there is no context (the jar is correctly
   * disabled), but the Sentinel pool still needs an account-scoped key — it
   * does not depend on cookies. Last resort: a device/session/profile key for
   * tests that never passed an account handle.
   */
  private resolveSentinelContextKey(): string {
    if (this.browserSessionContextKey) return this.browserSessionContextKey;
    if (this.browserSessionAccountId) return `${this.browserSessionAccountId}:fallback-profile`;
    const { browserProfile, deviceId, sessionId } = this.client;
    if (deviceId && sessionId && browserProfile?.id)
      return deriveSentinelContextKey({ deviceId, profileId: browserProfile.id, sessionId });
    return 'chatgptweb:unscoped';
  }

  private releaseSessionContext(): void {
    this.sessionContext?.release?.();
  }

  async chat(payload: ChatStreamPayload, options?: ChatMethodOptions): Promise<Response> {
    return runChatGPTWebChat(payload, options, {
      buildMessages: (messages, signal) => this.buildMessages(messages, signal),
      client: this.client,
      finalizeTurn: this.finalizeTurn,
      hideTurn: this.hideTurn,
      log,
      provider: this.provider,
      releaseSessionContext: () => this.releaseSessionContext(),
      resolveFile: this.resolveFile,
      resolveImage: this.resolveImage,
      sentinelContextKey: this.resolveSentinelContextKey(),
      toRuntimeError: (error) => this.toRuntimeError(error),
      trackConversation: (events, turn) => this.trackConversation(events, turn),
    });
  }

  /**
   * ChatGPT.com has no native JSON-schema / tool-calling generateObject path.
   * Structured output is collected from a non-streaming `chat` turn with a
   * JSON-only instruction; Instant/Pro still resolve through the family mapper.
   * Caller-supplied `tools` are dropped — the web backend does not accept them.
   */
  async generateObject(
    payload: GenerateObjectPayload,
    options?: GenerateObjectOptions,
  ): Promise<unknown> {
    return runChatGPTWebGenerateObject({
      chat: this.chat.bind(this),
      options,
      payload,
      provider: this.provider,
    });
  }

  async createImage(
    payload: CreateImagePayload,
    options?: CreateImageMethodOptions,
  ): Promise<CreateImageResponse> {
    try {
      return await createChatGPTWebImage(payload, {
        client: this.client,
        options,
        provider: this.provider,
      });
    } finally {
      this.releaseSessionContext();
    }
  }

  async models(options?: { signal?: AbortSignal }): Promise<ChatModelCard[]> {
    const { applyChatGPTWebModelPolicy, LOBE_DEFAULT_MODEL_LIST } = await import('model-bank');

    let models: Awaited<ReturnType<ChatGPTWebClient['listModels']>>;
    try {
      models = await this.client.listModels(options?.signal);
    } catch (error) {
      throw this.toRuntimeError(error);
    } finally {
      this.releaseSessionContext();
    }

    const known = (slug: string) =>
      LOBE_DEFAULT_MODEL_LIST.find((item) => item.id === slug && item.providerId === this.provider);

    /**
     * A slug the catalogue does not know yet (chatgpt.com ships new checkpoints
     * well before we do) still has to be usable, so give it the defaults every
     * ChatGPT Web model shares plus the abilities its name implies.
     */
    const toCard = (
      slug: string,
      live?: { description?: string; maxTokens?: number; title?: string },
    ): ChatModelCard => {
      const card = known(slug);
      const reasoning =
        slug.endsWith('-thinking') || slug.endsWith('-pro') || slug.startsWith('o3');
      const settings = applyChatGPTWebModelPolicy({
        abilities: card?.abilities,
        modelId: slug,
        providerId: this.provider,
        settings: card?.settings ?? { ...LIVE_MODEL_SETTINGS },
      }).settings;
      return {
        contextWindowTokens:
          card?.contextWindowTokens ?? live?.maxTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
        description: card?.description ?? live?.description,
        displayName: card?.displayName ?? live?.title ?? slug,
        enabled: card?.enabled ?? false,
        // the web backend runs its own built-in tools for every model
        files: card?.abilities?.files ?? true,
        functionCall: false,
        id: slug,
        imageOutput: card?.abilities?.imageOutput ?? true,
        reasoning: card?.abilities?.reasoning ?? reasoning,
        search: card?.abilities?.search ?? true,
        // Unknown slugs get thinking / pro controls from the policy helper
        // (`*-thinking` / `*-pro`); everything else has no effort picker.
        settings: settings ?? { ...LIVE_MODEL_SETTINGS },
        type: 'chat' as const,
        vision: card?.abilities?.vision ?? true,
      };
    };

    const cards: ChatModelCard[] = models
      .filter((model) => !isHiddenModelSlug(model.slug))
      .map((model) => toCard(model.slug, model));

    // `auto` is accepted as a model but is not advertised by /backend-api/models.
    if (!cards.some((card) => card.id === 'auto'))
      cards.unshift({
        ...toCard('auto'),
        displayName: known('auto')?.displayName ?? 'Auto',
        // `auto` is what the web app itself defaults to — always offer it
        enabled: known('auto')?.enabled ?? true,
        reasoning: known('auto')?.abilities?.reasoning ?? true,
      });

    return cards;
  }

  // ------------------------------------------------------------------ payload

  private buildMessages(messages: ChatStreamPayload['messages'], signal?: AbortSignal) {
    return buildChatGPTWebMessages(messages, {
      client: this.client,
      logUploadFailure: (kind, error) =>
        log(
          kind === 'image' ? 'image upload failed: %s' : 'document upload failed: %s',
          String(error),
        ),
      signal,
      uploadNamespace: this.uploadNamespace,
    });
  }

  // ------------------------------------------------------------------ helpers

  private async *trackConversation(events: AsyncIterable<ConversationEvent>, turn: TurnState) {
    for await (const event of events) {
      if (event.type === 'conversation.start') turn.conversationId = event.conversationId;
      else if (event.type === 'done' && event.conversationId)
        turn.conversationId = event.conversationId;
      yield event;
    }
  }

  private resolveImage = async (
    pointer: ChatGPTWebImagePointer,
    turn: TurnState,
    signal?: AbortSignal,
  ): Promise<string | undefined> => {
    const url =
      pointer.pointerKind === 'file-service'
        ? await this.client.getFileDownloadUrl(pointer.fileId, signal)
        : turn.conversationId
          ? await this.client.getAttachmentDownloadUrl(turn.conversationId, pointer.fileId, signal)
          : '';

    if (!url) return undefined;

    const { bytes, mimeType } = await this.client.downloadBytes(url, signal);
    const resolved = mimeType || readImageMimeType(bytes) || 'image/png';
    return `data:${resolved};base64,${bytesToBase64(bytes)}`;
  };

  /**
   * Download a code-interpreter output and describe it as a `file` chunk.
   *
   * Runs INSIDE the stream (before `done`), because the cleanup hook hides the
   * conversation the sandbox path belongs to. Bounded by
   * {@link MAX_DOWNLOAD_BYTES} like every other asset we pull.
   */
  private resolveFile = async (
    pointer: ChatGPTWebFilePointer,
    turn: TurnState,
    signal?: AbortSignal,
  ): Promise<StreamFileData | undefined> => {
    const conversationId = pointer.conversationId ?? turn.conversationId;
    if (!conversationId || !pointer.messageId) return undefined;

    const { downloadUrl, name } = await this.client.resolveInterpreterFile({
      conversationId,
      messageId: pointer.messageId,
      sandboxPath: pointer.sandboxPath,
      signal,
    });
    if (!downloadUrl) return undefined;

    const { bytes, mimeType } = await this.client.downloadBytes(downloadUrl, {
      maxBytes: MAX_DOWNLOAD_BYTES,
      signal,
    });
    if (bytes.length === 0) return undefined;

    // the upstream name is advisory; the sanitizer owns what we hand downstream
    const fileName = sandboxFileName(name || pointer.name || pointer.sandboxPath);
    const resolvedMime = resolveFileMimeType(mimeType, fileName);

    return {
      data: `data:${resolvedMime};base64,${bytesToBase64(bytes)}`,
      mimeType: resolvedMime,
      name: fileName,
      size: bytes.length,
      sourcePath: pointer.sandboxPath,
    };
  };

  /**
   * Post-turn recovery from the conversation document:
   * - citations are never streamed, they are only committed to the document;
   * - a handed-off turn is normally picked back up by the resume stream, but if
   *   that continuation failed the answer still has to be recovered here.
   *
   * Then hide the conversation so the account history does not fill up.
   */
  private finalizeTurn = async (
    {
      citationsEmitted,
      conversationId,
      hadError,
      hadOutput,
      recoveryRequired,
      searchUsed,
      text,
    }: ChatGPTWebDoneContext,
    turn: TurnState,
    searchRequested: boolean,
    signal?: AbortSignal,
  ): Promise<ChatGPTWebDoneResult | undefined> => {
    if (!conversationId) return undefined;

    const result: ChatGPTWebDoneResult = {};

    // Two recoverable shapes: a turn that produced NOTHING (handed off to the
    // background and never resumed) and a turn whose resume leg failed part-way
    // (`recoveryRequired`) and may therefore have been cut mid-answer.
    //
    // A turn that already reported an ERROR is not recovered: the user has been
    // shown the failure, and polling would add four minutes of waiting to it.
    if ((!hadOutput || recoveryRequired) && !hadError) {
      const answer = await this.pollForAnswer(conversationId, turn, signal);
      // additive contract: only what the stream has not already delivered
      const suffix = answer?.text ? undeliveredSuffix(answer.text, text) : '';
      if (suffix) result.text = suffix;
      if (answer?.citations?.length)
        result.grounding = { citations: answer.citations.map(toGroundingCitation) };

      // The recovered answer is the only place a handed-off turn's interpreter
      // files are visible — the stream never carried its `sandbox:` links.
      if (answer?.text && answer.messageId) {
        const messageId = answer.messageId;
        const files: ChatGPTWebRecoveredFile[] = [];
        for (const reference of extractSandboxFiles(answer.text)) {
          try {
            const file = await this.resolveFile(
              {
                conversationId,
                messageId,
                name: reference.name,
                sandboxPath: reference.path,
              },
              turn,
              signal,
            );
            // the chunk is keyed by the assistant message, like a streamed file
            if (file) files.push({ file, messageId });
          } catch (error) {
            const callerReason = callerAbortReason(signal);
            if (callerReason !== undefined) throw callerReason;
            // shape only — a download error can carry the signed URL
            log(
              'failed to resolve a recovered file: %s',
              error instanceof Error ? error.name : typeof error,
            );
          }
        }
        if (files.length > 0) result.files = files;
      }
    }

    if (!result.grounding && !citationsEmitted && (searchRequested || searchUsed)) {
      try {
        const document = await this.client.getConversation(
          conversationId,
          timeoutSignal(CITATION_FETCH_TIMEOUT_MS),
        );
        const citations = extractCitations(document, this.turnAnchor(turn));
        if (citations.length > 0)
          result.grounding = { citations: citations.map(toGroundingCitation) };
      } catch (error) {
        log('citation fetch failed: %s', String(error));
      }
    }

    return result;
  };

  /**
   * Soft-hide the conversation this turn created. Idempotent and
   * fire-and-forget: it runs from the stream's `finally`, so it must never keep
   * the response open nor throw into it.
   */
  private hideTurn = (turn: TurnState, conversationId?: string) => {
    const id = conversationId ?? turn.conversationId;
    if (!id || turn.hidden) return;
    turn.hidden = true;
    void this.client.hideConversation(id, timeoutSignal(HIDE_TIMEOUT_MS));
  };

  private turnAnchor = ({ startedAtSec, userMessageId }: TurnState) => ({
    since: startedAtSec,
    userMessageId,
  });

  /**
   * Poll the conversation document until THIS turn's assistant answer is
   * finished. Used only when the stream (and its resume continuation) produced
   * nothing.
   *
   * Hard-bounded: the budget is a real deadline that also cuts an in-flight
   * document read short, the sleeps are abortable, and expiry THROWS a typed
   * timeout — reporting a silent success would hand the user a stale answer or
   * an empty turn dressed up as a finished one.
   */
  private async pollForAnswer(
    conversationId: string,
    turn: TurnState,
    signal?: AbortSignal,
  ): Promise<{ citations: Citation[]; messageId?: string; text: string } | undefined> {
    const anchor = this.turnAnchor(turn);
    const budget = timeoutSignalHandle(ANSWER_POLL_BUDGET_MS);
    const composed = composeSignals([signal, budget.signal]);

    try {
      while (!budget.signal.aborted) {
        // rejects with the caller's own abort reason, or the budget's timeout
        await abortableSleep(ANSWER_POLL_INTERVAL_MS, composed.signal);

        let document;
        try {
          document = await this.client.getConversation(conversationId, {
            signal: composed.signal,
          });
        } catch (error) {
          const callerReason = callerAbortReason(signal);
          if (callerReason !== undefined) throw callerReason;
          if (budget.signal.aborted) break;
          if (isChatGPTWebError(error) && RETRYABLE_POLL_STATUSES.has(error.status ?? 0)) continue;
          log('answer poll failed: %s', String(error));
          return undefined;
        }

        const message = turnAnswerMessage(document, anchor);
        if (!message) continue;

        const raw = messageParts(message);
        // A finished unclassified bento tool-call strips to '' and would look
        // like "the turn produced nothing". Keep polling until a real answer
        // is written; a genuinely empty finished message still stops below.
        if (isBentoOnlyText(raw)) continue;

        const text = sanitizeAnnotations(stripBentoLayout(raw));
        const finished =
          message.status === 'finished_successfully' ||
          message.status === 'finished_partial_completion' ||
          message.end_turn === true;

        if (!finished) continue;
        // finished without text ⇒ nothing to recover, stop polling
        return text
          ? {
              citations: extractCitations(document, anchor),
              messageId: typeof message.id === 'string' ? message.id : undefined,
              text,
            }
          : undefined;
      }
    } finally {
      budget.cleanup();
      composed.cleanup();
    }

    log('answer poll timed out for %s', conversationId);
    throw new ChatGPTWebError(
      'timeout',
      `the background answer was still not written after ${Math.round(ANSWER_POLL_BUDGET_MS / 1000)}s`,
    );
  }

  private toRuntimeError(error: unknown) {
    if (isChatGPTWebError(error)) {
      const message =
        error.kind === 'transport_unavailable'
          ? `${error.message}. The ChatGPT Web provider needs the TLS-impersonating transport (curl-impersonate) on the server.`
          : error.kind === 'cloudflare'
            ? `${error.message}. chatgpt.com is challenging this server; retry in a moment or check the outbound proxy.`
            : error.message;

      return AgentRuntimeError.chat({
        // NEVER `error.body`: an upstream body carries conversation content and,
        // on the sentinel/file paths, credentials. Only our own safe fields.
        error: { code: error.code, kind: error.kind, message, status: error.status },
        errorType: toAgentRuntimeErrorType(error),
        message,
        provider: this.provider,
      });
    }

    if ((error as { errorType?: unknown } | undefined)?.errorType) return error;

    const message = error instanceof Error ? error.message : String(error);
    return AgentRuntimeError.chat({
      error: { message },
      errorType: AgentRuntimeErrorType.ProviderBizError,
      message,
      provider: this.provider,
    });
  }
}
