import createDebug from 'debug';

import { randomUuid } from './binary';
import {
  CHATGPT_BASE_URL,
  DEFAULT_USER_AGENT,
  PATHS,
  RETRYABLE_POLL_STATUSES,
  TEMPLATED_ROUTES,
  TIMEOUTS,
} from './constants';
import {
  callerAbortReason,
  ChatGPTWebError,
  classifyResponseError,
  isChatGPTWebError,
} from './errors';
import {
  buildBlobUploadHeaders,
  buildBootstrapHeaders,
  buildSentinelHeaders,
  rejectCrlf,
  sanitizeHeaderValue,
} from './headers';
import {
  ChatGPTWebHttp,
  composeSignals,
  type ManagedResponse,
  readBodySafely,
  timeoutSignal,
} from './http';
import type { PowResources } from './pow';
import { buildFileCreateBody } from './requestBuilders';
import {
  buildRequirementsToken,
  parseClientBuildInfo,
  resolvePowResources,
  type SentinelFinalizeResponse,
  type SentinelPrepareResponse,
  solveSentinelChallenges,
  toChatRequirements,
} from './sentinel';
import { ConversationEventRouter } from './sse/events';
import { iterSsePayloads } from './sse/reader';
import type {
  ChatRequirements,
  ConversationDocument,
  ConversationEvent,
  UploadedFileRef,
} from './types';

const log = createDebug('lobe-chatgptweb:client');

/** Chained `/f/conversation/resume` legs allowed for a single turn. */
const MAX_CHAINED_RESUMES = 3;
/** Backoff between resume attempts (network / 5xx only). */
const RESUME_BACKOFF_MS = [300, 700, 1500];
const RESUME_RETRIES = RESUME_BACKOFF_MS.length;

/** Event types that mean the leg actually produced something for the consumer. */
const OUTPUT_EVENT_TYPES = new Set<ConversationEvent['type']>([
  'text.delta',
  'reasoning.delta',
  'reasoning.done',
  'citations',
  'image.pointer',
  'file.pointer',
  'moderation',
  'error',
]);

export interface StreamConversationOptions {
  /**
   * Follow a `stream_handoff` onto `/f/conversation/resume` (default `true`).
   * Turn it off to observe the raw upstream behaviour.
   */
  autoResume?: boolean;
  conduitToken?: string;
  /** Assistant turns we replayed, so the upstream echo can be dropped. */
  echoHistory?: string[];
  hardCapMs?: number;
  idleTimeoutMs?: number;
  /** Chained resume legs allowed for this turn. */
  maxResumes?: number;
  requirements: ChatRequirements;
  signal?: AbortSignal;
  useFPath?: boolean;
}

export interface ResumeConversationOptions {
  conversationId: string;
  echoHistory?: string[];
  hardCapMs?: number;
  idleTimeoutMs?: number;
  /** Events already consumed; `0` replays the turn from its start. */
  offset?: number;
  /** The `resume_conversation_token` JWT from the handed-off stream. */
  resumeToken: string;
  signal?: AbortSignal;
}

interface LegRequest {
  body: string;
  context: string;
  headers: Record<string, string>;
  path: string;
  /** Retries allowed while ESTABLISHING this leg (network / 5xx). */
  retries?: number;
}

interface LegState {
  conversationId?: string;
  handoff?: Extract<ConversationEvent, { type: 'handoff' }>;
  resumeToken?: string;
  sawOutput: boolean;
}

/**
 * Hosts an upstream-supplied URL may point at.
 *
 * Every one of these URLs (`upload_url`, `download_url`, asset pointers) is read
 * out of a response body, i.e. it is attacker-influenced input to a server-side
 * fetch. The server transport enforces its own SSRF policy; this is the second
 * line of defence, so a compromised/spoofed response cannot make the runtime
 * fetch `http://169.254.169.254/…` or an internal service with the account's
 * bearer token attached.
 */
const ASSET_HOST_SUFFIXES = [
  'chatgpt.com',
  'openai.com',
  'oaiusercontent.com',
  'oaistatic.com',
  'blob.core.windows.net',
];

export const isAllowedAssetUrl = (url: string): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  return ASSET_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
};

/**
 * @returns the parsed URL, so the caller can decide same-origin questions on the
 *   PARSED host rather than on a string prefix.
 */
export const assertAllowedAssetUrl = (url: string, context: string): URL => {
  if (!isAllowedAssetUrl(url))
    // the URL itself is never interpolated: its query string is the credential
    throw new ChatGPTWebError(
      'upstream',
      `${context}: refusing to fetch an asset from an unexpected host or scheme`,
    );
  return new URL(url);
};

/** `''` (nothing to download) or an allowlisted URL — never anything else. */
const checkedAssetUrl = (url: string | undefined, context: string): string => {
  if (!url) return '';
  assertAllowedAssetUrl(url, context);
  return url;
};

const isRetryableLegError = (error: unknown): boolean => {
  if (!isChatGPTWebError(error)) return false;
  return error.kind === 'network' || (error.status ?? 0) >= 500;
};

const buildResumeLeg = ({
  conversationId,
  offset = 0,
  resumeToken,
}: {
  conversationId: string;
  offset?: number;
  resumeToken: string;
}): LegRequest => ({
  body: JSON.stringify({ conversation_id: conversationId, offset }),
  context: 'conversation_resume',
  headers: {
    'Accept': 'text/event-stream',
    'Content-Type': 'application/json',
    'X-Conduit-Token': sanitizeHeaderValue(resumeToken),
    'X-Oai-Turn-Trace-Id': randomUuid(),
  },
  path: PATHS.fConversationResume,
  retries: RESUME_RETRIES,
});

/**
 * Protocol client for chatgpt.com's private web API.
 *
 * All network calls go through the injected `fetch` (the server injects a
 * TLS-impersonating transport; the default `globalThis.fetch` works in tests but
 * gets Cloudflare-challenged against the real origin).
 */
export class ChatGPTWebClient extends ChatGPTWebHttp {
  private powResources?: PowResources;

  // ------------------------------------------------------------------ account

  async getMe(signal?: AbortSignal): Promise<{ email?: string; id?: string; raw: unknown }> {
    const raw = await this.requestJson<Record<string, any>>({
      context: 'me',
      path: PATHS.me,
      signal,
      timeoutMs: 20_000,
    });
    return { email: raw?.email, id: raw?.id, raw };
  }

  async getAccountsCheck(signal?: AbortSignal): Promise<{
    accountId?: string;
    hasActiveSubscription?: boolean;
    planType: string;
    raw: unknown;
  }> {
    const raw = await this.requestJson<Record<string, any>>({
      context: 'accounts_check',
      path: PATHS.accountsCheck,
      // the target path/route headers deliberately exclude the query string
      query: `?timezone_offset_min=${this.timezoneOffsetMin}`,
      signal,
    });
    const account = raw?.accounts?.default?.account;
    return {
      accountId: account?.account_id,
      hasActiveSubscription: raw?.accounts?.default?.entitlement?.has_active_subscription,
      planType: account?.plan_type ?? 'free',
      raw,
    };
  }

  async getConversationInit(signal?: AbortSignal): Promise<{
    defaultModelSlug?: string;
    imageQuotaRemaining?: number;
    imageQuotaResetAfter?: string;
    limitsProgress: unknown[];
  }> {
    const raw = await this.requestJson<Record<string, any>>({
      ...this.jsonBody({
        conversation_id: null,
        gizmo_id: null,
        requested_default_model: null,
        timezone_offset_min: this.timezoneOffsetMin,
      }),
      context: 'conversation_init',
      path: PATHS.conversationInit,
      signal,
    });

    const limitsProgress: any[] = Array.isArray(raw?.limits_progress) ? raw.limits_progress : [];
    const imageGen = limitsProgress.find((item) => item?.feature_name === 'image_gen');
    return {
      defaultModelSlug: raw?.default_model_slug,
      imageQuotaRemaining:
        imageGen?.remaining === undefined ? undefined : Number(imageGen.remaining) || 0,
      imageQuotaResetAfter: imageGen?.reset_after ? String(imageGen.reset_after) : undefined,
      limitsProgress,
    };
  }

  async listModels(
    signal?: AbortSignal,
  ): Promise<
    { description?: string; maxTokens?: number; raw: unknown; slug: string; title?: string }[]
  > {
    const raw = await this.requestJson<Record<string, any>>({
      context: 'models',
      path: PATHS.models,
      query: '?history_and_training_disabled=false',
      signal,
    });
    const models: any[] = Array.isArray(raw?.models) ? raw.models : [];
    return models
      .filter((model) => typeof model?.slug === 'string' && model.slug)
      .map((model) => ({
        description: model.description,
        maxTokens: model.max_tokens,
        raw: model,
        slug: model.slug,
        title: model.title,
      }));
  }

  // ----------------------------------------------------------------- sentinel

  /**
   * The bootstrap HTML is the request most likely to be Cloudflare-challenged;
   * on failure we fall back to the default SDK script, which the upstream
   * accepts. Cached for the lifetime of the client.
   */
  private async bootstrapPowResources(signal?: AbortSignal): Promise<PowResources> {
    if (this.powResources) return this.powResources;

    let html: string | undefined;
    try {
      const managed = await this.rawFetch(
        `${CHATGPT_BASE_URL}/`,
        { headers: buildBootstrapHeaders(this.fingerprint) },
        { context: 'bootstrap', signal, timeoutMs: TIMEOUTS.bootstrap },
      );
      try {
        // the deadline stays armed until the HTML is fully read
        if (managed.response.ok) html = await managed.response.text();
        else
          log(
            'bootstrap returned %d, falling back to the default pow script',
            managed.response.status,
          );
      } finally {
        managed.release();
      }
    } catch (error) {
      // a caller-initiated stop is not a "bootstrap failure" to shrug off
      const callerReason = callerAbortReason(signal);
      if (callerReason !== undefined) throw callerReason;
      log('bootstrap failed (%s), falling back to the default pow script', String(error));
    }

    // The bootstrap also carries the live build markers the session headers
    // advertise; keep the pinned constants when it could not be read.
    const { buildNumber, clientVersion } = parseClientBuildInfo(html);
    if (clientVersion) this.fingerprint.clientVersion = clientVersion;
    if (buildNumber) this.fingerprint.clientBuildNumber = buildNumber;

    this.powResources = resolvePowResources(html);
    return this.powResources;
  }

  async getChatRequirements({
    onProgress,
    powLimit,
    signal,
  }: {
    onProgress?: (stage: 'bootstrap' | 'prepare' | 'solve' | 'finalize') => void;
    powLimit?: number;
    signal?: AbortSignal;
  } = {}): Promise<ChatRequirements> {
    onProgress?.('bootstrap');
    const resources = await this.bootstrapPowResources(signal);
    const userAgent = this.userAgent || DEFAULT_USER_AGENT;
    const requirementsToken = buildRequirementsToken(resources, userAgent);

    onProgress?.('prepare');
    const prepare = await this.retryOnCloudflare(
      () =>
        this.requestJson<SentinelPrepareResponse>({
          ...this.jsonBody({ p: requirementsToken }),
          context: 'sentinel_prepare',
          path: `${PATHS.sentinelRequirements}/prepare`,
          signal,
          timeoutMs: TIMEOUTS.sentinel,
        }),
      signal,
    );

    onProgress?.('solve');
    const challenges = await solveSentinelChallenges({
      powLimit,
      prepare,
      requirementsToken,
      resources,
      signal,
      userAgent,
    });

    onProgress?.('finalize');
    const finalize = await this.retryOnCloudflare(
      () =>
        this.requestJson<SentinelFinalizeResponse>({
          ...this.jsonBody({
            prepare_token: prepare.prepare_token,
            proof_token: challenges.proofToken,
            turnstile_token: challenges.turnstileToken,
          }),
          context: 'sentinel_finalize',
          path: `${PATHS.sentinelRequirements}/finalize`,
          signal,
          timeoutMs: TIMEOUTS.sentinel,
        }),
      signal,
    );

    return toChatRequirements(finalize, challenges);
  }

  /**
   * A Cloudflare interstitial on the sentinel handshake is usually transient —
   * one immediate re-issue clears it. Retried exactly once, with a small jitter
   * so a burst of clients does not resynchronise, and never against a caller
   * that has already cancelled.
   */
  private async retryOnCloudflare<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const callerReason = callerAbortReason(signal);
      if (callerReason !== undefined) throw callerReason;
      if (!isChatGPTWebError(error) || error.kind !== 'cloudflare') throw error;
      log('sentinel call was Cloudflare-challenged, retrying once');
      await abortableSleep(300 + Math.floor(Math.random() * 500), signal);
      return run();
    }
  }

  // ------------------------------------------------------------- conversation

  async prepareConversation(
    body: object,
    { requirements, signal }: { requirements?: ChatRequirements; signal?: AbortSignal } = {},
  ): Promise<{ conduitToken: string }> {
    const raw = await this.requestJson<{ conduit_token?: string }>({
      body: JSON.stringify(body),
      context: 'conversation_prepare',
      headers: requirements
        ? buildSentinelHeaders({ accept: '*/*', requirements, variant: 'conduit' })
        : { 'Content-Type': 'application/json', 'X-Conduit-Token': 'no-token' },
      method: 'POST',
      path: PATHS.fConversationPrepare,
      signal,
    });

    // A 200 without a usable token is a FAILED prepare: the conduit path then
    // streams without `X-Conduit-Token` and dies upstream, while the caller
    // believes it prepared successfully and never takes its plain fallback.
    // `upstream` keeps it recoverable — the legacy endpoint needs no token.
    const conduitToken = typeof raw?.conduit_token === 'string' ? raw.conduit_token.trim() : '';
    if (!conduitToken)
      throw new ChatGPTWebError(
        'upstream',
        'conversation_prepare failed: the response carried no conduit token',
        { status: 200 },
      );

    return { conduitToken };
  }

  /**
   * Stream one turn, transparently following the upstream's **handoff**.
   *
   * A turn the backend decides to run in the background (thinking / pro / any
   * explicit `thinking_effort`) answers the conversation call with nothing but a
   * `resume_conversation_token`, a `stream_handoff` and `[DONE]` — the real
   * answer is then streamed by `POST /backend-api/f/conversation/resume`
   * (verified live 2026-08-15). We follow that continuation here so consumers
   * see one uninterrupted event stream instead of an empty turn.
   *
   * The resume leg replays the turn from the start; the SAME event router is fed
   * across legs so the replay is diffed against what we already emitted and only
   * genuinely new text/reasoning reaches the consumer.
   */
  async *streamConversation(
    body: object,
    {
      autoResume = true,
      conduitToken,
      echoHistory,
      hardCapMs = TIMEOUTS.streamHardCap,
      idleTimeoutMs = TIMEOUTS.streamIdle,
      maxResumes = MAX_CHAINED_RESUMES,
      requirements,
      signal,
      useFPath,
    }: StreamConversationOptions,
  ): AsyncGenerator<ConversationEvent, void, undefined> {
    const deadline = timeoutSignal(hardCapMs);
    const composed = composeSignals([signal, deadline.signal]);
    const legOptions = {
      deadlineSignal: deadline.signal,
      idleTimeoutMs,
      signal: composed.signal,
    };
    // one router for the whole turn: it dedupes what a resume leg replays
    const router = new ConversationEventRouter({ echoHistory });

    let request: LegRequest = {
      body: JSON.stringify(body),
      context: 'conversation',
      headers: buildSentinelHeaders({
        accept: 'text/event-stream',
        conduitToken,
        requirements,
        variant: useFPath ? 'conduit' : 'conversation',
      }),
      path: useFPath ? PATHS.fConversation : PATHS.conversation,
    };

    try {
      let conversationId: string | undefined;

      for (let resumes = 0; ; resumes += 1) {
        const state: LegState = { sawOutput: false };
        let done: Extract<ConversationEvent, { type: 'done' }> | undefined;
        let managed: ManagedResponse | undefined;

        try {
          managed = await this.openLeg(request, composed.signal);
          for await (const event of this.readLeg(managed, router, legOptions, state)) {
            // both are turn bookkeeping, not output the consumer should see
            if (event.type === 'handoff') continue;
            if (event.type === 'done') {
              done = event;
              continue;
            }
            yield event;
          }
        } catch (error) {
          // A failed RESUME is recoverable: the answer is still being written
          // upstream, so end the turn and let the caller fall back to reading
          // the conversation document. A failed FIRST leg is not.
          //
          // `recoveryRequired` is the difference between "recoverable" and
          // "clean": a leg that already emitted some text would otherwise look
          // like a finished (but silently truncated) answer to the consumer.
          if (resumes === 0 || callerAbortReason(composed.signal) !== undefined) throw error;
          log('resume leg failed (%s); falling back to document recovery', String(error));
          yield { conversationId, endTurn: false, recoveryRequired: true, type: 'done' };
          return;
        } finally {
          managed?.release();
        }

        conversationId = state.conversationId ?? conversationId;
        const resumeToken = state.handoff?.resumeToken ?? state.resumeToken;
        const resumeId = state.handoff?.conversationId ?? conversationId;
        // A finished turn keeps advertising its handoff options — resuming it
        // again only replays what we already streamed.
        const handedOff = done?.endTurn !== true && (!!state.handoff || !state.sawOutput);

        if (!autoResume || !handedOff || !resumeToken || !resumeId || resumes >= maxResumes) {
          const final = done ?? { conversationId, endTurn: false, type: 'done' as const };
          // still handed off with nowhere left to go (no token, resume budget
          // spent, following disabled): the answer lives in the document only
          yield handedOff ? { ...final, recoveryRequired: true } : final;
          return;
        }

        log('turn handed off; resuming %s (leg %d)', resumeId, resumes + 2);
        request = buildResumeLeg({ conversationId: resumeId, resumeToken });
      }
    } finally {
      deadline.cleanup();
      composed.cleanup();
    }
  }

  /**
   * `POST /backend-api/f/conversation/resume` — pick a handed-off turn back up.
   * Same JSON-patch protocol as the conversation call; the reply replays the
   * turn from `offset` (the router's visibility gates drop the replayed
   * system/user messages).
   */
  async *resumeConversation({
    conversationId,
    echoHistory,
    hardCapMs = TIMEOUTS.streamHardCap,
    idleTimeoutMs = TIMEOUTS.streamIdle,
    offset = 0,
    resumeToken,
    signal,
  }: ResumeConversationOptions): AsyncGenerator<ConversationEvent, void, undefined> {
    const deadline = timeoutSignal(hardCapMs);
    const composed = composeSignals([signal, deadline.signal]);
    let managed: ManagedResponse | undefined;

    try {
      managed = await this.openLeg(
        buildResumeLeg({ conversationId, offset, resumeToken }),
        composed.signal,
      );
      yield* this.readLeg(
        managed,
        new ConversationEventRouter({ echoHistory }),
        { deadlineSignal: deadline.signal, idleTimeoutMs, signal: composed.signal },
        { sawOutput: false },
      );
    } finally {
      managed?.release();
      deadline.cleanup();
      composed.cleanup();
    }
  }

  /**
   * Open one SSE leg. Resume legs are retried on a network hiccup / 5xx: the
   * turn is already running upstream and losing the continuation would strand a
   * finished answer.
   */
  private async openLeg(
    request: LegRequest,
    signal: AbortSignal | undefined,
  ): Promise<ManagedResponse> {
    const retries = request.retries ?? 0;

    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.request({
          accept: 'text/event-stream',
          body: request.body,
          context: request.context,
          headers: request.headers,
          method: 'POST',
          path: request.path,
          signal,
          // the stream is bounded by hardCapMs / idleTimeoutMs instead
          timeoutMs: 0,
        });
      } catch (error) {
        // covers the caller's stop AND our own hard cap (composed signal)
        const abortReason = callerAbortReason(signal);
        if (abortReason !== undefined) throw abortReason;
        if (attempt >= retries || !isRetryableLegError(error)) throw error;
        log('%s failed (%s), retrying', request.context, String(error));
        await abortableSleep(
          RESUME_BACKOFF_MS[Math.min(attempt, RESUME_BACKOFF_MS.length - 1)],
          signal,
        );
      }
    }
  }

  /** Feed one leg's SSE payloads through the (turn-scoped) event router. */
  private async *readLeg(
    managed: ManagedResponse,
    router: ConversationEventRouter,
    {
      deadlineSignal,
      idleTimeoutMs,
      signal,
    }: { deadlineSignal?: AbortSignal; idleTimeoutMs?: number; signal?: AbortSignal },
    state: LegState,
  ): AsyncGenerator<ConversationEvent, void, undefined> {
    if (!managed.response.body)
      throw new ChatGPTWebError('upstream', 'conversation response carried no body');

    try {
      // `iterSsePayloads` THROWS on abort / hard cap / idle, so a truncated turn
      // can never surface as a `done` event here.
      for await (const payload of iterSsePayloads(managed.response.body, {
        deadlineSignal,
        idleTimeoutMs,
        signal,
      })) {
        for (const event of router.feed(payload)) {
          if (event.type === 'handoff') state.handoff = event;
          if (event.type === 'conversation.start') state.conversationId = event.conversationId;
          if (OUTPUT_EVENT_TYPES.has(event.type)) state.sawOutput = true;
          yield event;
          if (event.type === 'done') return;
        }
      }
    } finally {
      state.conversationId ??= router.currentConversationId;
      state.resumeToken ??= router.resumeToken;
    }
  }

  /**
   * @param accept the image path reads this document as JSON; the search path in
   *   the reference client sends `*\/*`. Defaults to JSON.
   */
  async getConversation(
    id: string,
    signalOrOptions?: AbortSignal | { accept?: string; signal?: AbortSignal },
  ): Promise<ConversationDocument> {
    const options =
      signalOrOptions && 'aborted' in signalOrOptions
        ? { signal: signalOrOptions }
        : (signalOrOptions ?? {});

    return this.requestJson<ConversationDocument>({
      accept: options.accept ?? 'application/json',
      context: 'conversation_document',
      headers: { Referer: `${CHATGPT_BASE_URL}/c/${id}` },
      path: `${PATHS.conversation}/${id}`,
      // the web client sends the un-interpolated template here
      route: TEMPLATED_ROUTES.conversation,
      signal: options.signal,
    });
  }

  /** Soft-hide a conversation (`is_visible: false`). Best effort, never throws. */
  async hideConversation(id: string, signal?: AbortSignal): Promise<void> {
    try {
      const managed = await this.request({
        accept: '*/*',
        body: JSON.stringify({ is_visible: false }),
        context: 'conversation_hide',
        headers: {
          'Content-Type': 'application/json',
          'Referer': `${CHATGPT_BASE_URL}/c/${id}`,
        },
        method: 'PATCH',
        path: `${PATHS.conversation}/${id}`,
        route: TEMPLATED_ROUTES.conversation,
        signal,
        timeoutMs: 15_000,
      });
      managed.release();
    } catch (error) {
      log('hideConversation failed for %s: %s', id, String(error));
    }
  }

  async listTasks(conversationId: string, signal?: AbortSignal): Promise<unknown[]> {
    const raw = await this.requestJson<{ tasks?: any[] }>({
      context: 'tasks',
      path: PATHS.tasks,
      signal,
      timeoutMs: 15_000,
    });
    const tasks = Array.isArray(raw?.tasks) ? raw.tasks : [];
    // the endpoint takes no filters — filter client side
    return tasks.filter(
      (task) =>
        task?.conversation_id === conversationId ||
        task?.original_conversation_id === conversationId,
    );
  }

  // -------------------------------------------------------------------- files

  async uploadFile(
    bytes: Uint8Array,
    meta: {
      height?: number;
      kind: 'image' | 'document';
      mimeType: string;
      name: string;
      width?: number;
    },
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<UploadedFileRef> {
    const created = await this.requestJson<{
      file_id?: string;
      library_file_id?: string;
      upload_url?: string;
    }>({
      ...this.jsonBody(
        buildFileCreateBody({
          height: meta.height,
          kind: meta.kind,
          mimeType: meta.mimeType,
          name: meta.name,
          size: bytes.length,
          timezoneOffsetMin: this.timezoneOffsetMin,
          width: meta.width,
        }),
      ),
      context: 'file_create',
      path: PATHS.files,
      signal,
    });

    if (!created.file_id || !created.upload_url)
      throw new ChatGPTWebError('upstream', 'file creation returned no upload url', {
        body: created,
      });

    await this.putBlob(created.upload_url, bytes, meta.mimeType, signal);

    const uploaded = await this.request({
      // the upstream expects the literal two-character body "{}"
      body: '{}',
      context: 'file_uploaded',
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
      path: `${PATHS.files}/${created.file_id}/uploaded`,
      signal,
    });
    uploaded.release();

    return {
      fileId: created.file_id,
      height: meta.height,
      kind: meta.kind,
      libraryFileId: created.library_file_id,
      mimeType: meta.mimeType,
      name: meta.name,
      size: bytes.length,
      width: meta.width,
    };
  }

  private async putBlob(
    uploadUrl: string,
    bytes: Uint8Array,
    mimeType: string,
    signal?: AbortSignal,
  ) {
    // the upload URL comes back from `POST /backend-api/files`, i.e. from a
    // response body — validate it before handing it to the transport
    assertAllowedAssetUrl(uploadUrl, 'file_upload');
    const managed = await this.rawFetch(
      uploadUrl,
      {
        body: bytes as unknown as BodyInit,
        headers: buildBlobUploadHeaders(this.fingerprint, mimeType),
        method: 'PUT',
      },
      { context: 'file_upload', signal, timeoutMs: TIMEOUTS.binary },
    );

    const { response } = managed;
    if (response.status >= 300) {
      let bodyText: string | undefined;
      try {
        bodyText = await readBodySafely(response, managed.fail);
      } finally {
        managed.release();
      }
      throw classifyResponseError({
        bodyText,
        context: 'file_upload',
        headers: response.headers,
        status: response.status,
      });
    }
    managed.release();
  }

  /**
   * Documents are indexed asynchronously; attaching one before the upstream is
   * done yields an *empty* retrieval — the model then answers about a file it
   * cannot read. Readiness therefore needs BOTH signals (E6 §2.4): a successful
   * retrieval index AND a numeric `file_token_size`.
   *
   * On deadline this THROWS a typed `timeout`. Callers that can degrade (e.g.
   * fall back to injecting the parsed text into the prompt) should catch it;
   * silently returning `{}` would have attached an unindexed document.
   */
  async waitForFileReady(
    fileId: string,
    {
      intervalMs = 2000,
      signal,
      timeoutMs = 120_000,
    }: { intervalMs?: number; signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<{ fileTokenSize?: number; status?: string }> {
    const startedAt = Date.now();
    let last: { fileTokenSize?: number; status?: string } = {};

    while (Date.now() - startedAt < timeoutMs) {
      const callerReason = callerAbortReason(signal);
      if (callerReason !== undefined) throw callerReason;

      try {
        const raw = await this.requestJson<Record<string, any>>({
          context: 'file_status',
          path: `${PATHS.files}/${fileId}`,
          signal,
        });
        const status = raw?.retrieval_index_status ?? raw?.status;
        last = {
          fileTokenSize: typeof raw?.file_token_size === 'number' ? raw.file_token_size : undefined,
          status: typeof status === 'string' ? status : undefined,
        };
        if (last.status === 'success' && typeof last.fileTokenSize === 'number') return last;
        if (last.status === 'failed')
          throw new ChatGPTWebError('upstream', `file ${fileId} failed to index`, { body: raw });
      } catch (error) {
        if (!isChatGPTWebError(error) || !RETRYABLE_POLL_STATUSES.has(error.status ?? 0))
          throw error;
      }

      await abortableSleep(intervalMs, signal);
    }

    throw new ChatGPTWebError(
      'timeout',
      `file ${fileId} was still not indexed after ${timeoutMs}ms`,
      { body: last },
    );
  }

  async getFileDownloadUrl(fileId: string, signal?: AbortSignal): Promise<string> {
    const raw = await this.requestJson<{ download_url?: string; url?: string }>({
      context: 'file_download_url',
      path: `${PATHS.files}/${fileId}/download`,
      signal,
    });
    return checkedAssetUrl(raw?.download_url ?? raw?.url, 'file_download_url');
  }

  async getAttachmentDownloadUrl(
    conversationId: string,
    attachmentId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const raw = await this.requestJson<{ download_url?: string; url?: string }>({
      context: 'attachment_download_url',
      path: `${PATHS.conversation}/${conversationId}/attachment/${attachmentId}/download`,
      signal,
    });
    return checkedAssetUrl(raw?.download_url ?? raw?.url, 'attachment_download_url');
  }

  /**
   * Resolve a code-interpreter output path (`/mnt/data/report.pdf`) into a
   * download URL.
   *
   * The python tool writes its files into a sandbox the answer text can only
   * reference as `sandbox:/mnt/data/…`; this endpoint is what the web client
   * itself calls to turn such a reference into real bytes. The URL it returns is
   * an `estuary/content` link that still needs the account bearer, which
   * {@link downloadBytes} attaches for chatgpt.com only.
   */
  async resolveInterpreterFile({
    conversationId,
    messageId,
    sandboxPath,
    signal,
  }: {
    conversationId: string;
    messageId: string;
    sandboxPath: string;
    signal?: AbortSignal;
  }): Promise<{ downloadUrl: string; fileId?: string; name?: string }> {
    // callers may pass the reference as it appeared in the text
    const path = sandboxPath.startsWith('sandbox:')
      ? sandboxPath.slice('sandbox:'.length)
      : sandboxPath;

    const raw = await this.requestJson<{
      download_url?: string;
      metadata?: { file_id?: string; file_name?: string; name?: string };
      url?: string;
    }>({
      context: 'interpreter_download',
      headers: { Referer: `${CHATGPT_BASE_URL}/c/${conversationId}` },
      path: `${PATHS.conversation}/${conversationId}/interpreter/download`,
      query: `?message_id=${encodeURIComponent(messageId)}&sandbox_path=${encodeURIComponent(path)}`,
      signal,
    });

    const downloadUrl = checkedAssetUrl(raw?.download_url ?? raw?.url, 'interpreter_download');
    const metadata = raw?.metadata;
    return {
      downloadUrl,
      fileId: typeof metadata?.file_id === 'string' ? metadata.file_id : undefined,
      name:
        (typeof metadata?.file_name === 'string' && metadata.file_name) ||
        (typeof metadata?.name === 'string' && metadata.name) ||
        undefined,
    };
  }

  /**
   * Fetch an asset URL handed to us by a download-url endpoint.
   *
   * Generated images resolve to `https://chatgpt.com/backend-api/estuary/content?…`,
   * which is NOT pre-signed and 403s without the bearer token — so we forward it,
   * but only for chatgpt.com itself. Third-party blob URLs are already signed and
   * must never see the credential.
   */
  async downloadBytes(
    url: string,
    signalOrOptions?: AbortSignal | { maxBytes?: number; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<{ bytes: Uint8Array; mimeType?: string }> {
    const {
      maxBytes = MAX_DOWNLOAD_BYTES,
      signal,
      timeoutMs = TIMEOUTS.binary,
    } = signalOrOptions && 'aborted' in signalOrOptions
      ? { signal: signalOrOptions }
      : (signalOrOptions ?? {});

    const parsed = assertAllowedAssetUrl(url, 'asset_download');
    const sameOrigin = parsed.origin === CHATGPT_BASE_URL;
    const managed = await this.rawFetch(
      url,
      {
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.8',
          // the token is user input; a CR/LF in it is request splitting in the
          // curl-backed transport, so it is REJECTED rather than mangled
          ...(sameOrigin
            ? {
                Authorization: `Bearer ${rejectCrlf('Authorization', this.fingerprint.accessToken)}`,
              }
            : {}),
          'Origin': CHATGPT_BASE_URL,
          'Referer': `${CHATGPT_BASE_URL}/`,
          'User-Agent': sanitizeHeaderValue(this.userAgent),
        },
      },
      { context: 'asset_download', signal, timeoutMs },
    );

    const { response } = managed;
    try {
      if (response.status >= 300)
        throw classifyResponseError({
          bodyText: await readBodySafely(response, managed.fail),
          context: 'asset_download',
          headers: response.headers,
          status: response.status,
        });

      // reject an oversized asset before reading it, when it announces itself
      const declared = Number(response.headers.get('content-length') ?? Number.NaN);
      if (Number.isFinite(declared) && declared > maxBytes)
        throw new ChatGPTWebError(
          'upstream',
          `asset is ${declared} bytes, over the ${maxBytes} byte limit`,
          { status: response.status },
        );

      return {
        bytes: await readBoundedBody(response, maxBytes, managed.fail),
        mimeType: response.headers.get('content-type') ?? undefined,
      };
    } finally {
      managed.release();
    }
  }
}

/** 32 MiB — comfortably above any generated image, far below "OOM the server". */
export const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;

/**
 * Stream a response body into memory with a hard ceiling.
 *
 * `arrayBuffer()` has no limit at all: an upstream (or a redirected blob host)
 * that answers with a huge or endlessly-chunked body would otherwise be able to
 * exhaust the process.
 */
export const readBoundedBody = async (
  response: Response,
  maxBytes: number,
  fail: (error: unknown) => Error = (error) => error as Error,
): Promise<Uint8Array> => {
  if (!response.body) {
    const buffer = await response.arrayBuffer().catch((error: unknown) => {
      throw fail(error);
    });
    if (buffer.byteLength > maxBytes)
      throw new ChatGPTWebError('upstream', `asset exceeds the ${maxBytes} byte limit`);
    return new Uint8Array(buffer);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new ChatGPTWebError('upstream', `asset exceeds the ${maxBytes} byte limit`);
      }
      chunks.push(value);
    }
  } catch (error) {
    throw isChatGPTWebError(error) ? error : fail(error);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
};

/** `setTimeout` that rejects with the caller's own abort reason. */
export const abortableSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const reason = callerAbortReason(signal);
    if (reason !== undefined) {
      reject(reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(callerAbortReason(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

// The protocol core's public surface. `index.ts` is intentionally left to the
// runtime layer (`LobeChatGPTWebAI`), so consumers import from here.
export * from './binary';
export * from './citations';
export * from './constants';
export * from './errors';
export * from './headers';
export * from './http';
export * from './pow';
export * from './requestBuilders';
export * from './sentinel';
export * from './sse/annotations';
export * from './sse/events';
export * from './sse/patch';
export * from './sse/reader';
export * from './turnstile';
export * from './types';
