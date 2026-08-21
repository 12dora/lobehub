import createDebug from 'debug';

import { assertAllowedAssetUrl, checkedAssetUrl } from './assetUrls';
import { abortableSleep, MAX_DOWNLOAD_BYTES, readBoundedBody } from './boundedBody';
import {
  CHATGPT_BASE_URL,
  PATHS,
  RETRYABLE_POLL_STATUSES,
  TEMPLATED_ROUTES,
  TIMEOUTS,
} from './constants';
import {
  callerAbortReason,
  ChatGPTWebError,
  classifyResponseError,
  describeResponseShape,
  describeThrownValue,
  isChatGPTWebError,
} from './errors';
import {
  buildAssetDownloadHeaders,
  buildBlobUploadHeaders,
  buildBootstrapHeaders,
  buildSentinelHeaders,
  buildTurnRequestHeaders,
  createTurnRequestIdentity,
  type TurnRequestIdentity,
} from './headers';
import type { ChatGPTWebClientOptions, ManagedResponse } from './http';
import { ChatGPTWebHttp, composeSignals, readBodySafely, timeoutSignal } from './http';
import type { PowResources } from './pow';
import { buildFileCreateBody } from './requestBuilders';
import type { LegRequest, LegState } from './resumeLeg';
import { buildResumeLeg, isRetryableLegError, RESUME_BACKOFF_MS } from './resumeLeg';
import type { SentinelFinalizeResponse, SentinelPrepareResponse } from './sentinel';
import {
  buildRequirementsToken,
  buildSentinelFinalizeBody,
  parseClientBuildInfo,
  resolvePowResources,
  resolveSentinelBundleExpiryMs,
  solveSentinelChallenges,
  toChatRequirements,
} from './sentinel';
import type {
  AcquiredSentinelBundle,
  MintedSentinelBundle,
  SentinelBundleBinding,
  SentinelBundlePool,
} from './sentinelBundlePool';
import { deriveSentinelContextKey, getSharedSentinelBundlePool } from './sentinelBundlePool';
import {
  startChatGPTWebSentinelKeepWarm,
  stopChatGPTWebSentinelKeepWarm,
} from './sentinelKeepWarm';
import { ConversationEventRouter } from './sse/events';
import { iterSsePayloads } from './sse/reader';
import { getDurationMs, timing } from './timing';
import type {
  ChatRequirements,
  ConversationDocument,
  ConversationEvent,
  UploadedFileRef,
} from './types';

const log = createDebug('lobe-chatgptweb:client');

/** Chained `/f/conversation/resume` legs allowed for a single turn. */
const MAX_CHAINED_RESUMES = 3;

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
  /**
   * Fired after the first SSE leg's HTTP headers succeed (status < 300) and
   * before any ConversationEvent. Used so the runtime can return a streaming
   * Response without waiting for `conversation.start`, while still classifying
   * 401/403 at open.
   */
  onHeaders?: () => void;
  requirements: ChatRequirements;
  signal?: AbortSignal;
  /** Shared with the prepare request for this browser turn. */
  turnIdentity?: TurnRequestIdentity;
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

/**
 * Protocol client for chatgpt.com's private web API.
 *
 * All network calls go through the injected `fetch` (the server injects a
 * TLS-impersonating transport; the default `globalThis.fetch` works in tests but
 * gets Cloudflare-challenged against the real origin).
 */
export interface ChatGPTWebClientInit extends ChatGPTWebClientOptions {
  /** Test seam — production uses the process-wide pool. */
  sentinelBundlePool?: SentinelBundlePool;
}

export class ChatGPTWebClient extends ChatGPTWebHttp {
  private powResources?: PowResources;
  private readonly sentinelPool: SentinelBundlePool;

  constructor(options: ChatGPTWebClientInit) {
    super(options);
    this.sentinelPool = options.sentinelBundlePool ?? getSharedSentinelBundlePool();
  }

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
   * accepts. Cached on the Browser Session Context (survives per-call client
   * reconstruction) and, failing that, on this instance.
   */
  private async bootstrapPowResources(signal?: AbortSignal): Promise<PowResources> {
    if (this.powResources) return this.powResources;
    const cached = this.sessionContext?.getBootstrap();
    if (cached?.powResources) {
      if (cached.clientVersion) this.fingerprint.clientVersion = cached.clientVersion;
      if (cached.clientBuildNumber) this.fingerprint.clientBuildNumber = cached.clientBuildNumber;
      this.powResources = cached.powResources;
      return this.powResources;
    }

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

    /**
     * An expired/missing web session gets the lightweight `/unauth-mweb/` shell.
     * Its build and asset graph are NOT the authenticated ChatGPT client this
     * runtime impersonates, so mixing them into the session headers / Sentinel
     * proof creates an impossible hybrid. Keep the pinned authenticated build
     * pair and SDK when that shell is all the bootstrap returned.
     */
    const unauthenticatedShell = Boolean(html?.includes('/unauth-mweb/'));
    const authenticatedHtml = unauthenticatedShell ? undefined : html;
    if (html && !authenticatedHtml)
      log('bootstrap returned the unauthenticated mweb shell; using pinned web-client markers');

    // The bootstrap also carries the live build markers the session headers
    // advertise; keep the pinned constants when it could not be read.
    const { buildNumber, clientVersion } = parseClientBuildInfo(authenticatedHtml);
    if (clientVersion) this.fingerprint.clientVersion = clientVersion;
    if (buildNumber) this.fingerprint.clientBuildNumber = buildNumber;

    this.powResources = resolvePowResources(authenticatedHtml);
    // An unauthenticated `/unauth-mweb/` shell is not a valid cache entry: the
    // next reconstructed client (after a session cookie is seeded) must retry
    // authenticated bootstrap instead of trusting pinned fallbacks forever.
    if (!unauthenticatedShell) {
      this.sessionContext?.setBootstrap({
        ...(this.fingerprint.clientBuildNumber
          ? { clientBuildNumber: this.fingerprint.clientBuildNumber }
          : {}),
        ...(this.fingerprint.clientVersion
          ? { clientVersion: this.fingerprint.clientVersion }
          : {}),
        powResources: this.powResources,
      });
    }
    return this.powResources;
  }

  /**
   * Mint a fresh Sentinel bundle from upstream. Does not touch the pool — image
   * generation and tests still call this for a blocking handshake. Conversation
   * turns should go through {@link acquireSentinelBundle} instead.
   */
  async getChatRequirements({
    onProgress,
    powLimit,
    signal,
  }: {
    onProgress?: (stage: 'bootstrap' | 'prepare' | 'solve' | 'finalize') => void;
    powLimit?: number;
    signal?: AbortSignal;
  } = {}): Promise<ChatRequirements> {
    return (await this.mintChatRequirements({ onProgress, powLimit, signal })).requirements;
  }

  /**
   * Take one ready bundle for this context. Cold contexts mint synchronously;
   * a warm pool returns immediately without a same-turn handshake.
   */
  async acquireSentinelBundle({
    contextKey,
    onProgress,
    powLimit,
    signal,
  }: {
    contextKey?: string;
    onProgress?: (stage: 'bootstrap' | 'prepare' | 'solve' | 'finalize') => void;
    powLimit?: number;
    signal?: AbortSignal;
  } = {}): Promise<AcquiredSentinelBundle> {
    const binding = this.sentinelBinding(contextKey);
    const startedAt = Date.now();
    let minted = false;
    const acquired = await this.sentinelPool.acquire(
      binding,
      (mintSignal) => {
        minted = true;
        return this.mintChatRequirements({ onProgress, powLimit, signal: mintSignal });
      },
      signal,
    );
    timing(
      'sentinel acquire source=%s durationMs=%d',
      minted ? 'cold' : 'warm',
      getDurationMs(startedAt),
    );
    return acquired;
  }

  /**
   * Fire-and-forget keep-warm for this context. Never throws into bind / chat.
   */
  keepSentinelWarm(contextKey?: string): void {
    try {
      startChatGPTWebSentinelKeepWarm(this.sentinelBinding(contextKey), (mintSignal) =>
        this.mintChatRequirements({ signal: mintSignal }),
      );
    } catch (error) {
      log('keepSentinelWarm failed: %s', describeThrownValue(error));
    }
  }

  /**
   * Park one ready bundle without consuming it. Call on context init/reconnect
   * so the first turn is not waiting on a background warm that never started.
   */
  async warmSentinelBundle({
    contextKey,
    signal,
  }: {
    contextKey?: string;
    signal?: AbortSignal;
  } = {}): Promise<void> {
    await this.sentinelPool.warm(
      this.sentinelBinding(contextKey),
      (mintSignal) => this.mintChatRequirements({ signal: mintSignal }),
      signal,
    );
  }

  /**
   * Start the next handshake in the background. Fire-and-forget: a failure
   * never rejects the current turn; the next acquire retries.
   *
   * Do not pass the turn abort signal — stopping a stream must not cancel the
   * next bundle.
   */
  replenishSentinelBundle({ contextKey }: { contextKey?: string } = {}): void {
    this.sentinelPool.replenish(this.sentinelBinding(contextKey), (mintSignal) =>
      this.mintChatRequirements({ signal: mintSignal }),
    );
  }

  /** Drop parked bundles when the context reconnects or the device/profile changes. */
  invalidateSentinelBundles(contextKey?: string): void {
    const key = this.resolveContextKey(contextKey);
    this.sentinelPool.invalidate(key);
    stopChatGPTWebSentinelKeepWarm(key);
  }

  private resolveContextKey(contextKey?: string): string {
    return (
      contextKey ??
      deriveSentinelContextKey({
        deviceId: this.deviceId,
        profileId: this.browserProfile.id,
        sessionId: this.sessionId,
      })
    );
  }

  private sentinelBinding(contextKey?: string): SentinelBundleBinding {
    return {
      clientBuildNumber: this.fingerprint.clientBuildNumber,
      clientVersion: this.fingerprint.clientVersion,
      contextKey: this.resolveContextKey(contextKey),
      deviceId: this.deviceId,
      profileId: this.browserProfile.id,
      sessionId: this.sessionId,
    };
  }

  private async mintChatRequirements({
    onProgress,
    powLimit,
    signal,
  }: {
    onProgress?: (stage: 'bootstrap' | 'prepare' | 'solve' | 'finalize') => void;
    powLimit?: number;
    signal?: AbortSignal;
  } = {}): Promise<MintedSentinelBundle> {
    const mark = async <T>(
      stage: 'bootstrap' | 'prepare' | 'solve' | 'finalize',
      work: () => Promise<T>,
    ): Promise<T> => {
      onProgress?.(stage);
      const startedAt = Date.now();
      try {
        return await work();
      } finally {
        timing('sentinel %s durationMs=%d', stage, getDurationMs(startedAt));
      }
    };

    const resources = await mark('bootstrap', () => this.bootstrapPowResources(signal));
    const userAgent = this.userAgent;
    const requirementsToken = buildRequirementsToken(resources, userAgent, this.browserProfile);

    const prepare = await mark('prepare', () =>
      this.retryOnCloudflare(
        () =>
          this.requestJson<SentinelPrepareResponse>({
            ...this.jsonBody({ p: requirementsToken }),
            context: 'sentinel_prepare',
            path: `${PATHS.sentinelRequirements}/prepare`,
            signal,
            timeoutMs: TIMEOUTS.sentinel,
          }),
        signal,
      ),
    );

    const challenges = await mark('solve', () =>
      solveSentinelChallenges({
        powLimit,
        prepare,
        browserProfile: this.browserProfile,
        requirementsToken,
        resources,
        signal,
        userAgent,
      }),
    );

    const finalize = await mark('finalize', () =>
      this.retryOnCloudflare(
        () =>
          this.requestJson<SentinelFinalizeResponse>({
            ...this.jsonBody(buildSentinelFinalizeBody(prepare.prepare_token, challenges)),
            context: 'sentinel_finalize',
            path: `${PATHS.sentinelRequirements}/finalize`,
            signal,
            timeoutMs: TIMEOUTS.sentinel,
          }),
        signal,
      ),
    );

    return {
      clientBuildNumber: this.fingerprint.clientBuildNumber,
      clientVersion: this.fingerprint.clientVersion,
      expiresAtMs: resolveSentinelBundleExpiryMs(finalize),
      requirements: toChatRequirements(finalize, challenges),
    };
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
    {
      signal,
      turnIdentity = createTurnRequestIdentity(),
    }: {
      requirements?: ChatRequirements;
      signal?: AbortSignal;
      turnIdentity?: TurnRequestIdentity;
    } = {},
  ): Promise<{ conduitToken?: string }> {
    const startedAt = Date.now();
    const raw = await this.requestJson<Record<string, any>>({
      body: JSON.stringify(body),
      context: 'conversation_prepare',
      // Real Chrome prepare calls carry the turn lifecycle headers, but none of
      // the Sentinel proofs; those belong on the subsequent SSE send.
      headers: {
        'Accept': '*/*',
        'Content-Type': 'application/json',
        ...buildTurnRequestHeaders(turnIdentity, 'prepare'),
      },
      method: 'POST',
      path: PATHS.fConversationPrepare,
      signal,
    });
    timing('prepare durationMs=%d', getDurationMs(startedAt));

    // `{status:"ok", conduit_token:null}` is a NORMAL prepare response, not a
    // failure — verified live 2026-08-19 against a captured real Chrome session:
    // the browser gets the exact same null token for a Pro-tier turn and simply
    // proceeds to `/backend-api/f/conversation` with no `X-Conduit-Token` header
    // at all (buildRequestHeaders already omits it when falsy). The previous
    // behavior — throwing here and letting the caller fall back to the legacy
    // `/backend-api/conversation` endpoint — is what silently substituted a mini
    // answer for a Pro turn the legacy endpoint structurally cannot serve. A
    // missing token is therefore no longer fatal; only genuinely broken
    // responses (network/timeout/malformed JSON, handled elsewhere in
    // `requestJson`) still throw.
    const conduitToken = typeof raw?.conduit_token === 'string' ? raw.conduit_token.trim() : '';
    if (!conduitToken) {
      log(
        'conversation_prepare returned no conduit token; response shape: %s',
        describeResponseShape(raw),
      );
      return {};
    }

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
      onHeaders,
      requirements,
      signal,
      turnIdentity,
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
        turnIdentity,
        variant: useFPath ? 'conduit' : 'conversation',
      }),
      path: useFPath ? PATHS.fConversation : PATHS.conversation,
    };

    try {
      let conversationId: string | undefined;
      let firstTextLogged = false;

      for (let resumes = 0; ; resumes += 1) {
        const state: LegState = { sawOutput: false };
        let done: Extract<ConversationEvent, { type: 'done' }> | undefined;
        let managed: ManagedResponse | undefined;

        try {
          const openStartedAt = Date.now();
          managed = await this.openLeg(request, composed.signal);
          if (resumes === 0) onHeaders?.();
          for await (const event of this.readLeg(
            managed,
            router,
            { ...legOptions, openStartedAt },
            state,
          )) {
            // both are turn bookkeeping, not output the consumer should see
            if (event.type === 'handoff') continue;
            if (event.type === 'done') {
              done = event;
              continue;
            }
            if (!firstTextLogged && event.type === 'text.delta') {
              firstTextLogged = true;
              timing('first text.delta durationMs=%d', getDurationMs(openStartedAt));
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
    const startedAt = Date.now();

    for (let attempt = 0; ; attempt += 1) {
      try {
        const managed = await this.request({
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
        timing('openLeg headers durationMs=%d path=%s', getDurationMs(startedAt), request.path);
        return managed;
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
      openStartedAt,
      signal,
    }: {
      deadlineSignal?: AbortSignal;
      idleTimeoutMs?: number;
      openStartedAt?: number;
      signal?: AbortSignal;
    },
    state: LegState,
  ): AsyncGenerator<ConversationEvent, void, undefined> {
    if (!managed.response.body)
      throw new ChatGPTWebError('upstream', 'conversation response carried no body');

    try {
      // `iterSsePayloads` THROWS on abort / hard cap / idle, so a truncated turn
      // can never surface as a `done` event here.
      let firstByteLogged = false;
      for await (const payload of iterSsePayloads(managed.response.body, {
        deadlineSignal,
        idleTimeoutMs,
        signal,
      })) {
        if (!firstByteLogged) {
          firstByteLogged = true;
          if (openStartedAt !== undefined)
            timing('openLeg first-byte durationMs=%d', getDurationMs(openStartedAt));
        }
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
          browserProfile: this.browserProfile,
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
        headers: buildAssetDownloadHeaders(this.fingerprint, { sameOrigin }),
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

export { abortableSleep, assertAllowedAssetUrl, MAX_DOWNLOAD_BYTES, readBoundedBody };
export { isAllowedAssetUrl } from './assetUrls';
export type { ChatGPTWebBootstrapState, ChatGPTWebSessionContext } from './sessionContext';
export { createMemoryChatGPTWebSessionContext } from './sessionContext';

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
export * from './sentinelBundlePool';
export * from './sse/annotations';
export * from './sse/bento';
export * from './sse/events';
export * from './sse/patch';
export * from './sse/reader';
export * from './turnstile';
export * from './types';
