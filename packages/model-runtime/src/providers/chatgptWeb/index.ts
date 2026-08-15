import type { ChatModelCard } from '@lobechat/types';
import createDebug from 'debug';

import type { LobeRuntimeAI } from '../../core/BaseAI';
import type {
  ChatGPTWebDoneContext,
  ChatGPTWebDoneResult,
  ChatGPTWebImagePointer,
} from '../../core/streams/chatgptWeb';
import { ChatGPTWebStream } from '../../core/streams/chatgptWeb';
import type {
  ChatMethodOptions,
  ChatStreamPayload,
  CreateImageMethodOptions,
  OpenAIChatMessage,
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
import type {
  AttachmentRef,
  ChatGPTWebMessage,
  Citation,
  ConversationEvent,
  UploadedFileRef,
} from './client';
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
  extractCitations,
  isCallerAbort,
  isChatGPTWebError,
  MAX_DOWNLOAD_BYTES,
  normalizeThinkingEffort,
  readBoundedBody,
  RETRYABLE_POLL_STATUSES,
  sanitizeAnnotations,
  toAgentRuntimeErrorType,
  turnAnswerMessage,
} from './client';
import { createChatGPTWebImage } from './createImage';
import { readImageDimensions, readImageMimeType } from './imageDimensions';
import { getCachedUpload, setCachedUpload, uploadCacheKey, uploadNamespace } from './uploadCache';

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
 * The app's effort scale (`none|minimal|low|medium|high|xhigh|max`) onto the
 * three levels chatgpt.com actually accepts — see `normalizeThinkingEffort`.
 */
const resolveThinkingEffort = (payload: ChatStreamPayload): string | undefined =>
  normalizeThinkingEffort(payload.reasoning_effort ?? payload.reasoning?.effort);

const extensionFor = (mimeType: string): string => {
  const subtype = mimeType.split('/')[1] ?? 'bin';
  return subtype === 'jpeg' ? 'jpg' : subtype.split('+')[0];
};

const toGroundingCitation = (citation: Citation) => ({ title: citation.title, url: citation.url });

/** Joined string parts of a conversation-document message. */
const messageParts = (message: Record<string, any>): string => {
  const parts = Array.isArray(message?.content?.parts) ? message.content.parts : [];
  return parts.filter((part: unknown) => typeof part === 'string').join('');
};

const toAttachmentRef = (ref: UploadedFileRef, name?: string): AttachmentRef => ({
  fileTokenSize: ref.fileTokenSize,
  height: ref.height,
  id: ref.fileId,
  kind: ref.kind,
  libraryFileId: ref.libraryFileId,
  mimeType: ref.mimeType,
  name: name ?? ref.name,
  size: ref.size,
  width: ref.width,
});

/** Never log a signed asset URL: the query string carries the credential. */
const urlHost = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return '<unparseable url>';
  }
};

/**
 * Structural metadata about an outgoing conversation body — message count, roles
 * and switches. Deliberately NOT the body: `messages[].content.parts` is the
 * user's whole prompt (and, on the document-fallback path, whole file contents),
 * which must never reach a log line.
 */
export const describeRequestBody = (
  body: Record<string, any>,
  extra: { flow: string; model?: string; thinkingEffort?: string },
): Record<string, unknown> => {
  const messages: any[] = Array.isArray(body?.messages) ? body.messages : [];
  return {
    ...extra,
    hasAttachments: messages.some(
      (message) => (message?.metadata?.attachments as unknown[] | undefined)?.length,
    ),
    messageCount: messages.length,
    roles: messages.map((message) => message?.author?.role),
    systemHints: body?.system_hints,
    thinkingEffortSent: body?.thinking_effort,
  };
};

/**
 * The part of a recovered answer the stream has NOT already delivered.
 *
 * The chunk contract is additive — a consumer concatenates every `text` chunk
 * and cannot take one back — so a partially streamed turn whose remainder is
 * read from the conversation document must be de-duplicated here.
 */
export const undeliveredSuffix = (recovered: string, streamed: string): string => {
  if (!streamed) return recovered;
  if (recovered.startsWith(streamed)) return recovered.slice(streamed.length);
  const index = recovered.indexOf(streamed);
  if (index >= 0) return recovered.slice(index + streamed.length);
  // the document and the stream disagree: appending would show the answer twice
  log('recovered answer diverges from the streamed text; appending nothing');
  return '';
};

/** Shared settings for a live slug the catalogue does not carry yet. */
const LIVE_MODEL_SETTINGS: NonNullable<ChatModelCard['settings']> = {
  searchImpl: 'params',
  searchProvider: DEFAULT_PROVIDER,
};

/**
 * Download an attachment referenced by URL. SSRF-safe on the server, plain fetch
 * in the browser bundle.
 *
 * Bounded in both directions: an announced `Content-Length` over the ceiling is
 * refused before a byte is read, and the body itself is streamed through
 * {@link readBoundedBody} so a chunked/endless response cannot exhaust the
 * process either.
 */
const fetchBytes = async (
  url: string,
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; mimeType?: string }> => {
  const isServer = typeof window === 'undefined';

  // `maxContentLength` soft-truncates one byte past the ceiling, which is what
  // lets `readBoundedBody` below tell "at the limit" from "over it".
  // TODO: `ssrfSafeFetch` console.errors its own caught fetch errors verbatim
  // (shared package). Nothing here can suppress that; fix it at the source.
  let response: Response;
  try {
    response = isServer
      ? await import('@lobechat/ssrf-safe-fetch').then((module) =>
          module.ssrfSafeFetch(url, { signal }, { maxContentLength: MAX_DOWNLOAD_BYTES + 1 }),
        )
      : await globalThis.fetch(url, { signal });
  } catch (error) {
    // the caller pressing stop keeps its own AbortError semantics
    if (isAbortError(error) || isCallerAbort(signal)) throw error;
    // host + error class only — a signed URL's query string IS the credential
    log('asset fetch failed: host=%s error=%s', urlHost(url), (error as Error)?.name ?? 'Error');
    // the MESSAGE carries the host only; the original stays on `cause`, which is
    // non-enumerable and therefore never lands in a serialized payload
    throw new Error(`failed to download attachment from ${urlHost(url)}`, { cause: error });
  }

  if (!response.ok)
    throw new Error(
      `failed to download attachment from ${urlHost(url)}: status=${response.status}`,
    );

  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES)
    throw new Error(
      `attachment from ${urlHost(url)} is ${declared} bytes, over the ${MAX_DOWNLOAD_BYTES} byte limit`,
    );

  return {
    bytes: await readBoundedBody(response, MAX_DOWNLOAD_BYTES),
    mimeType: response.headers.get('content-type') ?? undefined,
  };
};

/** A data URI's decoded size, bounded before it is ever materialised. */
const assertBoundedBase64 = (base64: string, what: string): void => {
  // 4 base64 chars ⇒ 3 bytes; compare on the ENCODED length so nothing is decoded first
  if (base64.length / 4 > MAX_DOWNLOAD_BYTES / 3)
    throw new Error(`inline ${what} exceeds the ${MAX_DOWNLOAD_BYTES} byte limit`);
};

/** Re-yield an iterator whose first result has already been pulled. */
async function* replayIterator<T>(
  first: IteratorResult<T>,
  iterator: AsyncIterator<T>,
): AsyncGenerator<T, void, undefined> {
  try {
    if (first.done) return;
    yield first.value;
    while (true) {
      const next = await iterator.next();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    // propagate cancellation (client abort) into the underlying SSE reader
    await iterator.return?.(undefined);
  }
}

export interface LobeChatGPTWebParams {
  /** ChatGPT Web access token (OAuth or pasted). */
  apiKey?: string;
  baseURL?: string;
  chatgptAccountId?: string;
  chatgptDeviceId?: string;
  /** Test seam — inject a pre-built (or fake) protocol client. */
  client?: ChatGPTWebClient;
  fetch?: typeof fetch;
  id?: string;
  userId?: string;
}

interface TurnState {
  conversationId?: string;
  /** the cleanup hook already fired — hiding twice is a wasted round trip */
  hidden?: boolean;
  /** Epoch SECONDS (the document's own unit) at which this request was sent. */
  startedAtSec?: number;
  /** The id we generated for this turn's last user message. */
  userMessageId?: string;
}

/** The id the body builder generated for the last user message of the turn. */
const lastUserMessageId = (body: Record<string, any>): string | undefined => {
  const messages: any[] = Array.isArray(body?.messages) ? body.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.author?.role === 'user' && typeof message.id === 'string') return message.id;
  }
  return undefined;
};

const isAbortError = (error: unknown): boolean =>
  (error as { name?: unknown } | undefined)?.name === 'AbortError';

/** A one-shot event stream that only ever throws — used to replay a caller abort. */
// eslint-disable-next-line require-yield -- intentionally yields nothing: it exists to throw
async function* throwingEvents(error: unknown): AsyncGenerator<ConversationEvent, void, undefined> {
  throw error;
}

/**
 * Redacting pass for the debug tee. The converted stream carries whole base64
 * images and grounding URLs whose query strings are credentials — neither
 * belongs in a log line.
 */
const createDebugRedactor = (): TransformStream<Uint8Array, Uint8Array> => {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';

  const redactFrame = (frame: string): string => {
    const dataIndex = frame.indexOf('data: ');
    if (dataIndex === -1) return frame;
    const head = frame.slice(0, dataIndex + 'data: '.length);
    const data = frame.slice(dataIndex + 'data: '.length);

    if (/^event: base64_image$/m.test(frame)) {
      const mime = /^"data:([^;]+);base64,/.exec(data)?.[1] ?? 'unknown';
      // the encoded length is a fine proxy; nothing is decoded to measure it
      return `${head}"<base64_image ${mime} ~${Math.floor((data.length * 3) / 4)} bytes>"`;
    }

    return head + data.replaceAll(/(https?:\/\/[^"\s\\]+?)\?[^"\s\\]*/g, '$1?<redacted>');
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    flush(controller) {
      if (buffer) controller.enqueue(encoder.encode(redactFrame(buffer)));
    },
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let index = buffer.indexOf('\n\n');
      while (index !== -1) {
        controller.enqueue(encoder.encode(`${redactFrame(buffer.slice(0, index))}\n\n`));
        buffer = buffer.slice(index + 2);
        index = buffer.indexOf('\n\n');
      }
    },
  });
};

export class LobeChatGPTWebAI implements LobeRuntimeAI {
  baseURL = 'https://chatgpt.com/backend-api';
  provider: string;

  private readonly client: ChatGPTWebClient;
  /**
   * Namespace for the process-wide upload cache. Uploaded file ids are
   * account-scoped, so the cache MUST NOT be shared between credentials — see
   * {@link uploadNamespace}.
   */
  private readonly uploadNamespace?: string;

  constructor({
    apiKey,
    baseURL,
    chatgptAccountId,
    chatgptDeviceId,
    client,
    fetch: customFetch,
    id,
  }: LobeChatGPTWebParams = {}) {
    if (!client && !apiKey)
      throw AgentRuntimeError.createError(AgentRuntimeErrorType.InvalidProviderAPIKey);

    this.provider = id || DEFAULT_PROVIDER;
    if (baseURL) this.baseURL = baseURL;

    this.client =
      client ??
      new ChatGPTWebClient({
        accessToken: apiKey!,
        accountId: chatgptAccountId,
        deviceId: chatgptDeviceId,
        fetch: customFetch,
      });

    this.uploadNamespace = uploadNamespace(chatgptAccountId ?? this.client.accountId, apiKey);
  }

  async chat(payload: ChatStreamPayload, options?: ChatMethodOptions): Promise<Response> {
    const inputStartAt = Date.now();
    const signal = options?.signal;

    try {
      const { echoHistory, inputText, messages, mimeTypes } = await this.buildMessages(
        payload.messages,
        signal,
      );

      const search = payload.enabledSearch === true;
      const hasAttachments = mimeTypes.length > 0;
      const thinkingEffort = resolveThinkingEffort(payload);
      // The `/f/` conduit path is what the web app uses whenever a turn carries
      // search, attachments or an explicit thinking effort — the plain
      // `/backend-api/conversation` body rejects `thinking_effort` with
      // 422 "Invalid conversation body" (verified live 2026-08-15).
      const useFPath = search || hasAttachments || !!thinkingEffort;
      const model = payload.model;

      const requirements = await this.client.getChatRequirements({ signal });

      let conduitToken: string | undefined;
      if (useFPath) {
        const prepare = buildPrepareBody({
          attachmentMimeTypes: hasAttachments ? mimeTypes : undefined,
          model,
          prompt: lastUserText(messages),
          systemHints: search ? ['search'] : [],
          thinkingEffort,
        });
        ({ conduitToken } = await this.client.prepareConversation(prepare, {
          requirements,
          signal,
        }));
      }

      const body = useFPath
        ? buildFConversationBody({ messages, model, search, thinkingEffort })
        : buildConversationBody({ messages, model, thinkingEffort });

      if (process.env[DEBUG_FLAG] === '1')
        log(
          'request: %o',
          describeRequestBody(body, {
            flow: useFPath
              ? search
                ? 'f:search'
                : hasAttachments
                  ? 'f:attachments'
                  : 'f:effort'
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
        useFPath,
      });
      const iterator = conversation[Symbol.asyncIterator]();

      // Pull the first event here so an upstream 401/403/429 becomes a proper
      // error Response instead of a mid-stream error chunk.
      const first = await iterator.next();

      const events = this.trackConversation(replayIterator(first, iterator), turn);

      const stream = ChatGPTWebStream(events, {
        callbacks: options?.callback,
        inputStartAt,
        inputText,
        model,
        // runs on success, failure AND abort — the created conversation must
        // never be left visible in the account history
        onCleanup: ({ conversationId }) => this.hideTurn(turn, conversationId),
        onDone: (context) => this.finalizeTurn(context, turn, search, signal),
        provider: this.provider,
        resolveImage: (pointer) => this.resolveImage(pointer, turn, signal),
        signal,
      });

      if (process.env[DEBUG_FLAG] === '1') {
        const [prod, useForDebug] = stream.tee();
        // never dump full base64 payloads / signed URLs into the log
        debugStream(useForDebug.pipeThrough(createDebugRedactor())).catch(console.error);
        return StreamingResponse(prod, { headers: options?.headers });
      }

      return StreamingResponse(stream, { headers: options?.headers });
    } catch (error) {
      // The user pressing stop is not a provider failure: surface the runtime's
      // abort terminal instead of an error card.
      if (isCallerAbort(signal) || isAbortError(error))
        return StreamingResponse(
          ChatGPTWebStream(throwingEvents(error), {
            callbacks: options?.callback,
            model: payload.model,
            provider: this.provider,
            signal,
          }),
          { headers: options?.headers },
        );

      throw this.toRuntimeError(error);
    }
  }

  async createImage(
    payload: CreateImagePayload,
    options?: CreateImageMethodOptions,
  ): Promise<CreateImageResponse> {
    return createChatGPTWebImage(payload, {
      client: this.client,
      options,
      provider: this.provider,
    });
  }

  async models(options?: { signal?: AbortSignal }): Promise<ChatModelCard[]> {
    const { LOBE_DEFAULT_MODEL_LIST } = await import('model-bank');

    let models: Awaited<ReturnType<ChatGPTWebClient['listModels']>>;
    try {
      models = await this.client.listModels(options?.signal);
    } catch (error) {
      throw this.toRuntimeError(error);
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
        slug.includes('-thinking') || slug.includes('-pro') || slug.startsWith('o3');
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
        // shares, or it advertises reasoning/search abilities with no way to
        // drive them: no effort selector, and a search toggle wired to nothing.
        settings:
          card?.settings ??
          (reasoning
            ? { ...LIVE_MODEL_SETTINGS, extendParams: ['gpt5_6ReasoningEffort'] }
            : { ...LIVE_MODEL_SETTINGS }),
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

    for (const message of messages) {
      const role =
        message.role === 'system' || message.role === 'assistant' ? message.role : 'user';

      const { attachments, text } = await this.buildContent(message.content, signal, () => {
        imageIndex += 1;
        return imageIndex;
      });

      if (!text && attachments.length === 0) continue;

      for (const attachment of attachments) mimeTypes.add(attachment.mimeType);
      if (role === 'assistant' && text) echoHistory.push(text);
      if (text) inputParts.push(text);

      mapped.push({
        attachments: attachments.length > 0 ? attachments : undefined,
        content: text,
        role,
      });
    }

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
  ): Promise<{ citations: Citation[]; text: string } | undefined> {
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
        return text ? { citations: extractCitations(document, anchor), text } : undefined;
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

const lastUserText = (messages: ChatGPTWebMessage[]): string => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') return messages[index].content;
  }
  return messages.at(-1)?.content ?? '';
};
