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
import { ChatGPTWebStream } from '../../core/streams/chatgptWeb';
import type {
  ChatMethodOptions,
  ChatStreamPayload,
  CreateImageMethodOptions,
  OpenAIChatMessage,
  StreamFileData,
  UserMessageContentPart,
  UserMessageContentPartFile,
} from '../../types';
import { fileUrlPartPlaceholder, isFileUrlPart, isFileUrlTypedPart } from '../../types/chat';
import { AgentRuntimeErrorType } from '../../types/error';
import type { CreateImagePayload, CreateImageResponse } from '../../types/image';
import { AgentRuntimeError } from '../../utils/createError';
import { debugStream } from '../../utils/debugStream';
import { StreamingResponse } from '../../utils/response';
import { parseDataUri } from '../../utils/uriParser';
import { assertBoundedBase64, extensionFor, fetchBytes } from './assetDownload';
import type { AttachmentRef, ChatGPTWebMessage, Citation, ConversationEvent } from './client';
import {
  abortableSleep,
  base64ToBytes,
  buildConversationBody,
  buildFConversationBody,
  buildPrepareBody,
  bytesToBase64,
  callerAbortReason,
  ChatGPTWebClient,
  ChatGPTWebError,
  composeSignals,
  createTurnRequestIdentity,
  deriveSentinelContextKey,
  extractCitations,
  isCallerAbort,
  isChatGPTWebError,
  MAX_DOWNLOAD_BYTES,
  RETRYABLE_POLL_STATUSES,
  sanitizeAnnotations,
  toAgentRuntimeErrorType,
  turnAnswerMessage,
} from './client';
import { createChatGPTWebImage } from './createImage';
import { createDebugRedactor } from './debugRedactor';
import { describeThrownValue } from './errors';
import { readImageDimensions, readImageMimeType } from './imageDimensions';
import { extractSandboxFiles, resolveFileMimeType, sandboxFileName } from './interpreterFiles';
import {
  chatgptWebFamilyBase,
  deriveChatGPTWebFamilyDisplayName,
  resolveChatGPTWebTurn,
} from './resolveTurnModel';
import type { ChatGPTWebSessionContext } from './sessionContext';
import type { TurnState } from './turnHelpers';
import {
  describeRequestBody,
  isAbortError,
  isRecoverablePrepareError,
  lastUserMessageId,
  lastUserText,
  messageParts,
  replayIterator,
  throwingEvents,
  toAttachmentRef,
  toGroundingCitation,
  undeliveredSuffix,
} from './turnHelpers';
import { getCachedUpload, setCachedUpload, uploadCacheKey, uploadNamespace } from './uploadCache';

export { describeRequestBody, undeliveredSuffix };

const log = createDebug('lobe-chatgptweb:runtime');

const DEFAULT_PROVIDER = 'chatgptweb';
const DEBUG_FLAG = 'DEBUG_CHATGPTWEB_CHAT_COMPLETION';

/** Slugs the web app advertises but that cannot serve a normal chat turn. */
const HIDDEN_MODEL_SLUGS = new Set(['research']);
const isHiddenModelSlug = (slug: string) => HIDDEN_MODEL_SLUGS.has(slug) || slug.endsWith('-wm');

/** Fallback context window for a live slug the catalogue does not carry yet. */
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;

const STREAM_HARD_CAP_MS = 300_000;
const STREAM_IDLE_MS = 60_000;
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

/**
 * `-pro` model ids (`gpt-5-6-pro`, `gpt-5-5-pro`, …) are the top research-grade tier —
 * on the real chatgpt.com client, PICKING Pro in the model switcher IS the effort
 * selection; there is no separate slider for it the way there is for `-thinking`
 * models, so a real Pro turn always carries `thinking_effort`. Verified against a
 * captured real Chrome session (2026-08-19, `chatgpt.com.har`): a Pro turn with no
 * explicit user-chosen effort sends `thinking_effort: "standard"` — the SAME
 * default other reasoning-capable tiers get, not `"max"`. (A `conduit_token: null`
 * prepare response turned out to be normal for this tier regardless of the effort
 * value sent — see the fix in `client.ts#prepareConversation` — so this default
 * is about matching the real request shape, not about unblocking the token.)
 *
 * Family cards (`gpt-5-6`, `gpt-5-5`) resolve Pro via {@link resolveChatGPTWebTurn}
 * *before* this check, so a family+pro turn takes the same dual-prepare path.
 */
const isProTierModel = (model: string): boolean => model.endsWith('-pro');

const FAMILY_EXTEND_PARAMS = ['chatgptWebReasoningEffort'] as const;

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
    const inputStartAt = Date.now();
    const signal = options?.signal;
    let streamConstructed = false;
    let leaseReleased = false;
    const releaseLease = () => {
      if (leaseReleased) return;
      leaseReleased = true;
      this.releaseSessionContext();
    };

    try {
      const { echoHistory, inputText, messages, mimeTypes } = await this.buildMessages(
        payload.messages,
        signal,
      );

      const search = payload.enabledSearch === true;
      const hasAttachments = mimeTypes.length > 0;
      const resolved = resolveChatGPTWebTurn({
        effort:
          payload.chatgptWebReasoningEffort ??
          payload.reasoning_effort ??
          payload.reasoning?.effort,
        model: payload.model,
      });
      const model = resolved.model;
      /**
       * Family+pro already carries `standard` from the helper. Legacy `*-pro`
       * SKUs with no effort still default to `standard` so the turn matches the
       * real Chrome request shape (and never falls back to the plain endpoint).
       */
      const thinkingEffort =
        resolved.thinkingEffort ?? (isProTierModel(model) ? 'standard' : undefined);
      /**
       * The `/f/` conduit path is what the web client uses for EVERY turn, and
       * it is the only one whose conversation the upstream keeps: the plain
       * `/backend-api/conversation` body sends `history_and_training_disabled`,
       * so its conversation cannot be read back afterwards (verified live
       * 2026-08-15 — the document, the interpreter download and even the hide
       * call all answer 404). Everything post-turn depends on that document:
       * code-interpreter files, citation recovery, background-answer recovery.
       *
       * Search / attachments / an explicit effort additionally CANNOT be
       * expressed by the plain body at all (`thinking_effort` is rejected with
       * 422 "Invalid conversation body"), so those turns never fall back.
       */
      const mayFallBack = !search && !hasAttachments && !thinkingEffort;

      const contextKey = this.resolveSentinelContextKey();
      const acquired = await this.client.acquireSentinelBundle({ contextKey, signal });
      const requirements = acquired.requirements;
      const turnIdentity = createTurnRequestIdentity();

      let useFPath = true;
      let conduitToken: string | undefined;
      try {
        const prepare = (clientPrepareState: 'sent' | 'success') =>
          buildPrepareBody({
            attachmentMimeTypes: hasAttachments ? mimeTypes : undefined,
            browserProfile: this.client.browserProfile,
            clientPrepareState,
            model,
            prompt: lastUserText(messages),
            systemHints: search ? ['search'] : [],
            thinkingEffort,
          });
        const prepareStates: Array<'sent' | 'success'> = isProTierModel(model)
          ? ['success', 'sent']
          : ['success'];
        const pendingPrepares = prepareStates.map((clientPrepareState) =>
          this.client.prepareConversation(prepare(clientPrepareState), {
            requirements,
            signal,
            turnIdentity,
          }),
        );

        if (isProTierModel(model)) {
          /**
           * Pro prepare calls are browser lifecycle observations, not a gate. In the real
           * Chrome HAR both calls started at +0/+11 ms, `/f/conversation` started at +98 ms,
           * and the prepare responses did not arrive until +1471/+1505 ms. Waiting for them
           * changes the protocol ordering — and a null conduit token cannot possibly be an
           * input to a send that was already in flight. Observe failures so no rejection is
           * lost, but launch the actual turn immediately just like the browser.
           */
          void Promise.allSettled(pendingPrepares).then((results) => {
            for (const result of results) {
              if (result.status === 'rejected')
                log(
                  'non-blocking Pro prepare failed after send: %s',
                  describeThrownValue(result.reason),
                );
              else if (result.value.conduitToken)
                log('non-blocking Pro prepare returned a late conduit token; ignoring it');
            }
          });
        } else {
          const prepared = await Promise.all(pendingPrepares);
          conduitToken = prepared.findLast((result) => result.conduitToken)?.conduitToken;
        }
      } catch (error) {
        // Only a failure the plain path can actually correct falls back: a
        // credential / cap / bot-protection failure is about the account, and
        // retrying it on the legacy endpoint only hides it behind a degraded
        // turn (see {@link isRecoverablePrepareError}).
        if (!mayFallBack || isCallerAbort(signal) || !isRecoverablePrepareError(error)) throw error;
        log('conduit prepare failed (%s); falling back to the plain path', String(error));
        useFPath = false;
        conduitToken = undefined;
      }

      const body = useFPath
        ? buildFConversationBody({
            browserProfile: this.client.browserProfile,
            messages,
            model,
            search,
            thinkingEffort,
          })
        : buildConversationBody({
            browserProfile: this.client.browserProfile,
            messages,
            model,
            thinkingEffort,
          });

      if (process.env[DEBUG_FLAG] === '1')
        log(
          'request: %o',
          describeRequestBody(body, {
            flow: useFPath
              ? search
                ? 'f:search'
                : hasAttachments
                  ? 'f:attachments'
                  : thinkingEffort
                    ? 'f:effort'
                    : 'f:plain'
              : 'conversation',
            model,
            thinkingEffort,
          }),
        );

      // Correlation anchors for the document fallback: everything we might read
      // back must descend from THIS user message (or post-date this request).
      const turn: TurnState = {
        startedAtSec: Date.now() / 1000,
        userMessageId: lastUserMessageId(body),
      };

      const conversation = this.client.streamConversation(body, {
        conduitToken,
        echoHistory,
        hardCapMs: STREAM_HARD_CAP_MS,
        idleTimeoutMs: STREAM_IDLE_MS,
        requirements,
        signal,
        turnIdentity,
        useFPath,
      });
      const iterator = conversation[Symbol.asyncIterator]();

      // Pull the first event here so an upstream 401/403/429 becomes a proper
      // error Response instead of a mid-stream error chunk. Kick the next
      // Sentinel handshake as soon as that request is in flight so it overlaps
      // the current stream; a replenish failure never rejects this turn.
      const firstPromise = iterator.next();
      this.client.replenishSentinelBundle({ contextKey });
      const first = await firstPromise;

      const events = this.trackConversation(replayIterator(first, iterator), turn);

      const stream = ChatGPTWebStream(events, {
        callbacks: options?.callback,
        inputStartAt,
        inputText,
        model,
        // runs on success, failure AND abort — the created conversation must
        // never be left visible in the account history. The session lease
        // lives until this cleanup so overflow eviction cannot drain a live
        // stream.
        onCleanup: ({ conversationId }) => {
          try {
            this.hideTurn(turn, conversationId);
          } finally {
            releaseLease();
          }
        },
        onDone: (context) => this.finalizeTurn(context, turn, search, signal),
        provider: this.provider,
        resolveFile: (pointer) => this.resolveFile(pointer, turn, signal),
        resolveImage: (pointer) => this.resolveImage(pointer, turn, signal),
        signal,
      });

      const cancelLeaseSources = () => {
        void stream.cancel().catch(() => undefined);
        const closing = iterator.return?.();
        if (closing && typeof (closing as Promise<unknown>).then === 'function') {
          void (closing as Promise<unknown>).catch(() => undefined);
        }
      };

      try {
        if (process.env[DEBUG_FLAG] === '1') {
          const [prod, useForDebug] = stream.tee();
          // never dump full base64 payloads / signed URLs into the log
          debugStream(useForDebug.pipeThrough(createDebugRedactor())).catch(console.error);
          const response = StreamingResponse(prod, { headers: options?.headers });
          streamConstructed = true;
          return response;
        }

        const response = StreamingResponse(stream, { headers: options?.headers });
        streamConstructed = true;
        return response;
      } catch (wrapError) {
        cancelLeaseSources();
        throw wrapError;
      }
    } catch (error) {
      // The user pressing stop is not a provider failure: surface the runtime's
      // abort terminal instead of an error card.
      if (isCallerAbort(signal) || isAbortError(error)) {
        const abortStream = ChatGPTWebStream(throwingEvents(error), {
          callbacks: options?.callback,
          model: payload.model,
          onCleanup: () => releaseLease(),
          provider: this.provider,
          signal,
        });
        try {
          const response = StreamingResponse(abortStream, { headers: options?.headers });
          streamConstructed = true;
          return response;
        } catch (wrapError) {
          void abortStream.cancel().catch(() => undefined);
          throw wrapError;
        }
      }

      throw this.toRuntimeError(error);
    } finally {
      if (!streamConstructed) releaseLease();
    }
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
    const { LOBE_DEFAULT_MODEL_LIST } = await import('model-bank');

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

    type LiveSlug = (typeof models)[number];

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
      const reasoning = slug.startsWith('o3');
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
        // An unknown slug still needs the settings every ChatGPT Web model
        // shares. Family cards carry the web picker; leftover slugs (minis, o3)
        // do not get the Platform gpt-5.6 effort control.
        settings: card?.settings ?? { ...LIVE_MODEL_SETTINGS },
        type: 'chat' as const,
        vision: card?.abilities?.vision ?? true,
      };
    };

    const toFamilyCard = (base: string, members: LiveSlug[]): ChatModelCard => {
      const card = known(base);
      const maxTokens = members.reduce<number | undefined>((current, member) => {
        if (typeof member.maxTokens !== 'number') return current;
        return current === undefined ? member.maxTokens : Math.max(current, member.maxTokens);
      }, undefined);
      const liveDescription = members.find((member) => member.description)?.description;

      return {
        contextWindowTokens:
          card?.contextWindowTokens ?? maxTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
        description: card?.description ?? liveDescription,
        displayName: card?.displayName ?? deriveChatGPTWebFamilyDisplayName(base, members),
        enabled: card?.enabled ?? false,
        files: card?.abilities?.files ?? true,
        functionCall: false,
        id: base,
        imageOutput: card?.abilities?.imageOutput ?? true,
        reasoning: true,
        search: card?.abilities?.search ?? true,
        settings: card?.settings ?? {
          ...LIVE_MODEL_SETTINGS,
          extendParams: [...FAMILY_EXTEND_PARAMS],
        },
        type: 'chat' as const,
        vision: card?.abilities?.vision ?? true,
      };
    };

    const visible = models.filter((model) => !isHiddenModelSlug(model.slug));
    const familyMembers = new Map<string, LiveSlug[]>();
    for (const live of visible) {
      const base = chatgptWebFamilyBase(live.slug);
      if (!base) continue;
      const group = familyMembers.get(base);
      if (group) group.push(live);
      else familyMembers.set(base, [live]);
    }

    const seenFamilies = new Set<string>();
    const cards: ChatModelCard[] = [];
    for (const live of visible) {
      const base = chatgptWebFamilyBase(live.slug);
      if (base) {
        if (seenFamilies.has(base)) continue;
        seenFamilies.add(base);
        cards.push(toFamilyCard(base, familyMembers.get(base) ?? [live]));
        continue;
      }
      cards.push(toCard(live.slug, live));
    }

    return cards;
  }

  // ------------------------------------------------------------------ payload

  private async buildMessages(
    messages: OpenAIChatMessage[],
    signal?: AbortSignal,
  ): Promise<{
    echoHistory: string[];
    inputText: string;
    messages: ChatGPTWebMessage[];
    mimeTypes: string[];
  }> {
    const mapped: ChatGPTWebMessage[] = [];
    const echoHistory: string[] = [];
    const inputParts: string[] = [];
    const mimeTypes = new Set<string>();
    let imageIndex = 0;
    /** System instructions waiting to be folded into the user turn they precede. */
    const pendingInstructions: string[] = [];

    const pushMessage = (message: ChatGPTWebMessage) => {
      if (message.content) inputParts.push(message.content);
      mapped.push(message);
    };

    /**
     * Emit the buffered instructions as the user turn they now are, at the
     * position the caller put them. Called whenever they would otherwise have to
     * CROSS an assistant turn to reach a later user message — carrying them past
     * it would reorder the conversation.
     */
    const flushInstructions = () => {
      if (pendingInstructions.length === 0) return;
      pushMessage({ content: pendingInstructions.join('\n\n'), role: 'user' });
      pendingInstructions.length = 0;
    };

    for (const message of messages) {
      const { attachments, text } = await this.buildContent(message.content, signal, () => {
        imageIndex += 1;
        return imageIndex;
      });

      if (!text && attachments.length === 0) continue;

      /**
       * A browser session NEVER authors a `system` turn. chatgpt.com's own
       * clients carry their instructions out of band (custom instructions ride
       * on flagged metadata, project/GPT instructions on the conversation
       * itself), so an `author.role: "system"` message with freeform text in
       * `content.parts` is a shape only an API/automation client produces — and
       * every AIHub turn produced one, because the context engine always
       * unshifts a system message (persona, date, model info, tool prompts).
       *
       * Fold it into the user turn it IMMEDIATELY precedes instead: the model
       * reads the same text in the same position, and the body keeps the
       * strictly user/assistant shape the web app sends. When no user turn
       * follows before the next assistant turn (or before the end), the
       * instruction is emitted as its own user turn rather than travelling
       * forward — see {@link flushInstructions}. A system message that carries
       * attachments is not an instruction block at all, so it falls through and
       * becomes a normal user turn (its files must not be dropped).
       */
      if (message.role === 'system' && attachments.length === 0) {
        if (text) pendingInstructions.push(text);
        continue;
      }

      const role = message.role === 'assistant' ? 'assistant' : 'user';

      // instructions may never be carried across an assistant turn
      if (role === 'assistant') flushInstructions();

      for (const attachment of attachments) mimeTypes.add(attachment.mimeType);
      if (role === 'assistant' && text) echoHistory.push(text);

      let content = text;
      if (role === 'user' && pendingInstructions.length > 0) {
        content = [...pendingInstructions, text].filter(Boolean).join('\n\n');
        pendingInstructions.length = 0;
      }

      pushMessage({
        attachments: attachments.length > 0 ? attachments : undefined,
        content,
        role,
      });
    }

    // A trailing system message (e.g. the force-finish injector) still has to
    // reach the model.
    flushInstructions();

    return {
      echoHistory,
      inputText: inputParts.join('\n\n'),
      messages: mapped,
      mimeTypes: [...mimeTypes],
    };
  }

  private async buildContent(
    content: OpenAIChatMessage['content'],
    signal: AbortSignal | undefined,
    nextImageIndex: () => number,
  ): Promise<{ attachments: AttachmentRef[]; text: string }> {
    if (typeof content === 'string') return { attachments: [], text: content };

    const attachments: AttachmentRef[] = [];
    const texts: string[] = [];

    for (const part of (content ?? []) as UserMessageContentPart[]) {
      if (isFileUrlTypedPart(part)) {
        // a malformed `file_url` part must never reach the wire
        if (!isFileUrlPart(part)) {
          texts.push(fileUrlPartPlaceholder(part));
          continue;
        }

        const attachment = await this.uploadDocumentPart(part, signal);
        if (attachment) attachments.push(attachment);
        else if (part.file_url.content)
          texts.push(`[Attached file: ${part.file_url.name}]\n${part.file_url.content}`);
        // no parsed content to fall back on: the shared placeholder contract
        else texts.push(fileUrlPartPlaceholder(part));
        continue;
      }

      switch (part.type) {
        case 'text': {
          if (part.text) texts.push(part.text);
          break;
        }
        case 'image_url': {
          const attachment = await this.uploadImagePart(
            part.image_url.url,
            nextImageIndex(),
            signal,
          );
          if (attachment) attachments.push(attachment);
          else texts.push('[image omitted: upload failed]');
          break;
        }
        // thinking blocks are internal; audio/video are unsupported upstream
        default: {
          break;
        }
      }
    }

    return { attachments, text: texts.join('\n\n') };
  }

  private async uploadImagePart(
    url: string,
    index: number,
    signal?: AbortSignal,
  ): Promise<AttachmentRef | undefined> {
    try {
      const parsed = parseDataUri(url);

      let bytes: Uint8Array;
      let mimeType: string | undefined;
      if (parsed.type === 'base64' && parsed.base64) {
        assertBoundedBase64(parsed.base64, 'image');
        bytes = base64ToBytes(parsed.base64);
        mimeType = parsed.mimeType ?? undefined;
      } else {
        // deliberately NOT `imageUrlToBase64`: that helper is unbounded and
        // ignores the caller's signal
        const downloaded = await fetchBytes(url, signal);
        bytes = downloaded.bytes;
        mimeType = downloaded.mimeType;
      }

      const dimensions = readImageDimensions(bytes);
      const resolvedMime = dimensions?.mimeType ?? mimeType ?? 'image/png';
      const name = `image_${index}.${extensionFor(resolvedMime)}`;

      const key = uploadCacheKey(this.uploadNamespace, bytes);
      const cached = getCachedUpload(key);
      if (cached) return toAttachmentRef(cached, name);

      const uploaded = await this.client.uploadFile(
        bytes,
        {
          height: dimensions?.height,
          kind: 'image',
          mimeType: resolvedMime,
          name,
          width: dimensions?.width,
        },
        { signal },
      );
      setCachedUpload(key, uploaded);

      return toAttachmentRef(uploaded, name);
    } catch (error) {
      log('image upload failed: %s', String(error));
      return undefined;
    }
  }

  private async uploadDocumentPart(
    part: UserMessageContentPartFile,
    signal?: AbortSignal,
  ): Promise<AttachmentRef | undefined> {
    const { mimeType, name, url } = part.file_url;
    try {
      const parsed = parseDataUri(url);
      let downloaded: { bytes: Uint8Array; mimeType?: string };
      if (parsed.type === 'base64' && parsed.base64) {
        assertBoundedBase64(parsed.base64, 'attachment');
        downloaded = {
          bytes: base64ToBytes(parsed.base64),
          mimeType: parsed.mimeType ?? undefined,
        };
      } else downloaded = await fetchBytes(url, signal);

      const resolvedMime = mimeType || downloaded.mimeType || 'application/octet-stream';
      const key = uploadCacheKey(this.uploadNamespace, downloaded.bytes);
      const cached = getCachedUpload(key);
      if (cached) return toAttachmentRef(cached, name);

      const uploaded = await this.client.uploadFile(
        downloaded.bytes,
        { kind: 'document', mimeType: resolvedMime, name },
        { signal },
      );

      // documents are indexed asynchronously; attaching one too early yields an
      // empty retrieval upstream
      const ready = await this.client.waitForFileReady(uploaded.fileId, { signal });
      const ref = { ...uploaded, fileTokenSize: ready.fileTokenSize };
      setCachedUpload(key, ref);

      return toAttachmentRef(ref, name);
    } catch (error) {
      log('document upload failed: %s', String(error));
      return undefined;
    }
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

        const text = sanitizeAnnotations(messageParts(message));
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
